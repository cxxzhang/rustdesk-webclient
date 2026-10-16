// Local defaults for window.__RD__ (see web/index.html).
// Everything here can be overridden per link with query params.
window.__RD_CONFIG = {
  // hbbs 公钥：cat E:\NetJobs\run\hbbs\id_ed25519.pub
  serverKeyB64: 'Ey8d3eOFd4eevMhaa4Syq48RlnoI0mJIgnKwXsZ7kZ0=',
  wsIdUrl: 'ws://localhost:8080/ws/id',
  wsRelayUrl: 'ws://localhost:8080/ws/relay',
  // 账号/设备列表走同源 /api，由 node 服务器（或生产里的反代）转到
  // rustdesk-api-server-pro。跨域直连会被浏览器拦，因为该服务端不发 CORS 头。
  apiBase: '/api',
  // WebRTC 用的 ICE 服务器。留空则只用公共 STUN。relay 策略下的 WebRTC 会话
  // 必须配 TURN（`turn://用户:密码@主机:端口`），否则 ICE 收集不到可用候选，
  // 直连永远不会建立 —— 那时会自动退回 WebSocket 中继，功能不受影响。
  iceServers: 'turn://andesk:andesk@192.168.32.1:3478',
  myName: 'webclient',

  // 白标。name 用在窗口标题和连接浮层；slug 用在下载文件名和本地存储键；
  // 颜色会作为 CSS 变量覆盖（配色取自 andesk.ico：深蓝底 + 淡蓝字 + 青边）。
  brand: {
    name: 'AnDesk',
    slug: 'andesk',
    logoUrl: './logo.png',
    accent: '#4c8dff',
    accent2: '#3a6fd8',
    accentFg: '#ffffff',
  },
};
