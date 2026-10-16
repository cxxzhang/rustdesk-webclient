package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/pion/turn/v4"
)

func cred(secret, username string) []byte {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	return turn.GenerateAuthKey(username, "andesk", base64.StdEncoding.EncodeToString(mac.Sum(nil)))
}

func TestRestAuthRejectsExpired(t *testing.T) {
	secret := "s3cret"
	rest := restAuth("andesk", secret)
	src := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1234}

	future := fmt.Sprintf("%d:andesk", time.Now().Add(time.Hour).Unix())
	if _, ok := rest(future, "andesk", src); !ok {
		t.Errorf("a valid future credential was rejected")
	}

	past := fmt.Sprintf("%d:andesk", time.Now().Add(-time.Hour).Unix())
	if _, ok := rest(past, "andesk", src); ok {
		t.Errorf("an expired credential was accepted")
	}

	if _, ok := rest("andesk", "andesk", src); ok {
		t.Errorf("a username without an expiry was accepted by restAuth")
	}
}

// The HMAC must match what the /ice-servers.json endpoint mints, or the
// browser's credential would be rejected by the very server that issued it.
func TestIssuedCredentialVerifies(t *testing.T) {
	secret := "s3cret"
	username := fmt.Sprintf("%d:andesk", time.Now().Add(time.Hour).Unix())
	if _, ok := restAuth("andesk", secret)(username, "andesk", nil); !ok {
		t.Errorf("the credential shape issued by serveIce is not accepted")
	}
}
