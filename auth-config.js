/* Firebase web-app settings are public client configuration, not server secrets.
   Enable Firebase Anonymous Authentication, Realtime Database, and Functions.
   Never put service-account keys or TURN credentials in this file. */
window.FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  appId: "",
  databaseURL: "",
  functionsRegion: "us-central1"
};

/* STUN supports many direct browser connections. Add TURN credentials from a
   managed TURN provider here for networks that cannot establish P2P directly. */
window.MINGLE_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" }
];
