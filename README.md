# Mingle

Mingle is a real-time stranger video chat front end. It uses Firebase anonymous guest accounts, Realtime Database presence and friend chat, callable Cloud Functions for matchmaking and friend requests, and browser WebRTC for one-to-one video. Google sign-in is not used.

The public GitHub Pages site is only the front end. Real online counts, matching, video signaling, friend requests, and messages are unavailable until you connect a Firebase project and deploy the backend.

## Firebase setup

You need a Firebase project that you own. The Firebase web app settings are public client configuration; do not publish service-account keys, private keys, or TURN credentials.

1. In [Firebase Console](https://console.firebase.google.com/), create or select a project and register a Web app.
2. Under **Authentication → Sign-in method**, enable **Anonymous**. No Google provider is needed.
3. Create a **Realtime Database**. Copy its database URL from the Realtime Database page.
4. Install Node.js 22 and the Firebase CLI, then sign in and select your project:

   ```powershell
   npm install -g firebase-tools
   firebase login
   firebase use --add
   ```

5. In the repository root, deploy the database rules and matchmaking/friend-request functions:

   ```powershell
   firebase deploy --only database,functions
   ```

   Cloud Functions deployment requires the Firebase **Blaze** billing plan. Review Firebase pricing and set budget alerts before upgrading; usage may incur charges.

6. In `auth-config.js`, set the web app's `apiKey`, `authDomain`, `projectId`, and `appId`, plus the Realtime Database `databaseURL`. Set `functionsRegion` if you deployed outside `us-central1`.
7. Commit and push `auth-config.js` to the public repository so GitHub Pages can load the Firebase client configuration. Keep your Firebase API key restricted to the site and review the Firebase security rules before opening the site to visitors.
8. Open the Pages site in two separate browser profiles/devices. Both visitors must allow camera and microphone access, choose profile gender, country, and at least one language, then press **Start matching**.

The online number counts connected guest sessions, including your own session. The match count excludes your session and reflects currently present people matching your filters.

## Video connection notes

WebRTC uses STUN by default. Some networks require a TURN relay. If calls fail on restrictive networks, configure a TURN service and add its ICE server settings to `MINGLE_ICE_SERVERS` in `auth-config.js`. TURN credentials must be rotated and kept private; a public static TURN secret should never be committed.

Friend requests are created during a live match. The recipient must accept before the friendship is saved and private text chat becomes available.

## Publish the static site

GitHub Pages serves the files from the repository root on `main`. Cloud Functions are deployed separately with the Firebase CLI; Pages does not run the backend.
