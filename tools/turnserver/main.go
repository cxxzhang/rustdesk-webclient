// Minimal TURN server for testing WebRTC through this stack.
//
// coturn is the right answer in production (Linux, battle-tested, standard
// config); this exists because coturn is not practical to run on Windows and
// the WebRTC path needs *a* TURN to exercise at all — rustdesk refuses to build
// an ICE offerer under a relay policy without one
// (see src/client.rs should_create_webrtc_offerer).
//
//   go run . -public-ip 192.168.32.1 -port 3478 -user andesk -pass andesk
//
// The relay address must be an address the *peers* can reach. For a machine
// behind NAT that is its public IP; -public-ip sets it explicitly.

package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pion/turn/v4"
)

// serveIce answers GET /ice-servers.json with the ICE list the web client
// should use. The credential is minted per request and expires, so a value
// scraped from a browser is useless shortly after; the shared secret itself
// never leaves this process.
//
// The shape matches what the client's `parseIceServers` accepts
// (`turn://user:pass@host:port`, comma separated).
func serveIce(addr, secret, user, realm, publicIP string, port, ttl int) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ice-servers.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// No-store: a cached copy would outlive the credential it carries.
		w.Header().Set("Cache-Control", "no-store")
		username := fmt.Sprintf("%d:%s", time.Now().Unix()+int64(ttl), user)
		mac := hmac.New(sha1.New, []byte(secret))
		mac.Write([]byte(username))
		pass := base64.StdEncoding.EncodeToString(mac.Sum(nil))
		url := fmt.Sprintf("turn://%s:%s@%s:%d",
			url.QueryEscape(username), url.QueryEscape(pass), publicIP, port)
		_ = json.NewEncoder(w).Encode(map[string]string{"iceServers": url})
	})
	log.Printf("ICE config on http://%s/ice-servers.json (realm=%s, ttl=%ds)", addr, realm, ttl)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Printf("ice config server stopped: %v", err)
	}
}

// looksTimeLimited reports whether a username is `<integer>:<label>`, the shape
// the time-limited scheme uses. A plain username (the static form) has no such
// prefix, so this only picks the check, not the verdict.
func looksTimeLimited(username string) bool {
	expiry, _, ok := strings.Cut(username, ":")
	if !ok {
		return false
	}
	_, err := strconv.ParseInt(expiry, 10, 64)
	return err == nil
}

// restAuth returns an AuthHandler for time-limited credentials: the client
// sends a username of `<expiry unix seconds>:<any label>` and the password
// base64(HMAC-SHA1(secret, that username)). Verification recomputes the HMAC
// and rejects an expired username, so the secret never leaves the server and a
// leaked credential stops working on its own.
//
// This is the same scheme coturn calls `use-auth-secret`, chosen over a static
// password because the browser gets its ICE configuration from a static file
// (`web/config.js`) that anyone can read.
func restAuth(realm, secret string) turn.AuthHandler {
	return func(username string, _ string, srcAddr net.Addr) ([]byte, bool) {
		expiry, _, ok := strings.Cut(username, ":")
		if !ok {
			log.Printf("auth rejected: username %q is not <expiry>:<label>", username)
			return nil, false
		}
		secs, err := strconv.ParseInt(expiry, 10, 64)
		if err != nil {
			log.Printf("auth rejected: bad expiry %q from %v", expiry, srcAddr)
			return nil, false
		}
		if time.Now().Unix() > secs {
			log.Printf("auth rejected: credential for %q expired %s ago", username,
				time.Since(time.Unix(secs, 0)).Truncate(time.Second))
			return nil, false
		}
		// The key is the HMAC itself, keyed by the secret over the username —
		// GenerateAuthKey does exactly this hash, so reuse it.
		mac := hmac.New(sha1.New, []byte(secret))
		mac.Write([]byte(username))
		key := turn.GenerateAuthKey(username, realm, base64.StdEncoding.EncodeToString(mac.Sum(nil)))
		return key, true
	}
}

func main() {
	publicIP := flag.String("public-ip", "", "IP advertised in relay candidates (REQUIRED)")
	port := flag.Int("port", 3478, "UDP port to listen on")
	realm := flag.String("realm", "andesk", "TURN realm")
	user := flag.String("user", "andesk", "TURN username")
	pass := flag.String("pass", "andesk", "TURN password")
	restSecret := flag.String("rest-secret", "", "shared secret for time-limited credentials; overrides -user/-pass")
	iceHTTP := flag.String("ice-http", "", "listen address for /ice-servers.json, e.g. 127.0.0.1:3479 (optional)")
	ttl := flag.Int("cred-ttl", 3600, "lifetime in seconds of an issued time-limited credential")
	flag.Parse()

	if *publicIP == "" {
		fmt.Fprintln(os.Stderr, "-public-ip is required (the address peers will be told to relay through)")
		os.Exit(2)
	}
	ip := net.ParseIP(*publicIP)
	if ip == nil {
		fmt.Fprintf(os.Stderr, "-public-ip %q is not an IP\n", *publicIP)
		os.Exit(2)
	}

	udp, err := net.ListenPacket("udp4", fmt.Sprintf("0.0.0.0:%d", *port))
	if err != nil {
		log.Fatalf("listen udp: %v", err)
	}
	tcp, err := net.Listen("tcp4", fmt.Sprintf("0.0.0.0:%d", *port))
	if err != nil {
		log.Fatalf("listen tcp: %v", err)
	}

	key := turn.GenerateAuthKey(*user, *realm, *pass)
	staticAuth := func(username string, realm string, srcAddr net.Addr) ([]byte, bool) {
		if username == *user {
			return key, true
		}
		log.Printf("auth rejected: user=%q from %v", username, srcAddr)
		return nil, false
	}
	auth := turn.AuthHandler(staticAuth)
	if *restSecret != "" {
		// Also accept time-limited credentials (the coturn "use-auth-secret"
		// scheme, the de-facto TURN REST API): username `<expiry>:<label>`,
		// password base64(HMAC-SHA1(secret, username)).
		//
		// Both forms are accepted at once, deliberately. The two clients differ
		// in who can read their credential: the browser is handed ICE config by
		// a server (short-lived, so a credential scraped from the page is
		// useless soon after), while the native rustdesk peer keeps
		// `ice-servers` in its own config on the machine being controlled, where
		// it was provisioned and is not public — and that client cannot mint a
		// time-limited credential. Accepting only the time-limited form would
		// break every provisioned peer.
		//
		// A time-limited username is routed straight to the HMAC check so the
		// static handler does not log a misleading rejection for it.
		rest := restAuth(*realm, *restSecret)
		auth = func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
			if !looksTimeLimited(username) {
				return staticAuth(username, realm, srcAddr)
			}
			key, ok := rest(username, realm, srcAddr)
			if ok {
				log.Printf("auth ok (time-limited): %q from %v", username, srcAddr)
			}
			return key, ok
		}
	}
	if *iceHTTP != "" {
		// Mint credentials here rather than in whatever serves the page: this
		// process already holds the secret, and an operator deploying the client
		// as a static tree (Caddy file_server) has no other place to run one.
		// Point the reverse proxy's /ice-servers.json at this listener.
		go serveIce(*iceHTTP, *restSecret, *user, *realm, *publicIP, *port, *ttl)
	}
	relay := &turn.RelayAddressGeneratorStatic{RelayAddress: ip, Address: "0.0.0.0"}

	srv, err := turn.NewServer(turn.ServerConfig{
		Realm:       *realm,
		AuthHandler: auth,
		PacketConnConfigs: []turn.PacketConnConfig{
			{PacketConn: udp, RelayAddressGenerator: relay},
		},
		ListenerConfigs: []turn.ListenerConfig{
			{Listener: tcp, RelayAddressGenerator: relay},
		},
	})
	if err != nil {
		log.Fatalf("turn server: %v", err)
	}
	defer srv.Close()

	log.Printf("TURN listening udp/tcp :%d realm=%s relay=%s user=%s", *port, *realm, ip, *user)
	// Client-side ICE config for rustdesk and the browser:
	log.Printf("  turn://%s:%s@%s:%d", *user, *pass, *publicIP, *port)

	select {}
}
