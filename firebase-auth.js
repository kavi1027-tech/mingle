import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const config = window.FIREBASE_CONFIG || {};
const configured = ["apiKey", "authDomain", "projectId", "appId"].every((key) =>
  typeof config[key] === "string" && config[key].trim().length > 0
);
const signInButton = document.getElementById("googleSignInButton");
const signOutButton = document.getElementById("signOutButton");
const profile = document.getElementById("signedInProfile");
const profileName = document.getElementById("profileName");
const profilePhoto = document.getElementById("profilePhoto");
const profileInitial = document.getElementById("profileInitial");

function showError(error) {
  const messages = {
    "auth/unauthorized-domain": "Add this website's domain to Firebase Authentication's authorized domains.",
    "auth/popup-blocked": "Allow pop-ups for this site, then try Google sign-in again.",
    "auth/popup-closed-by-user": "Google sign-in was closed before it finished.",
    "auth/operation-not-allowed": "Enable Google as a sign-in provider in Firebase Authentication."
  };
  window.showAppToast?.(messages[error.code] || "Google sign-in could not be completed. Please try again.");
}

function updateProfile(user) {
  signInButton.hidden = Boolean(user);
  profile.hidden = !user;
  if (!user) return;
  profileName.textContent = user.displayName || user.email || "Signed in";
  profileInitial.textContent = (user.displayName || user.email || "G").trim().charAt(0).toUpperCase();
  profilePhoto.hidden = !user.photoURL;
  profileInitial.hidden = Boolean(user.photoURL);
  if (user.photoURL) profilePhoto.src = user.photoURL;
}

if (configured) {
  try {
    const auth = getAuth(initializeApp(config));
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    window.firebaseAuthConfigured = true;
    onAuthStateChanged(auth, updateProfile, showError);

    signInButton.addEventListener("click", async () => {
      try {
        if (window.matchMedia("(max-width: 700px)").matches) {
          await signInWithRedirect(auth, provider);
        } else {
          await signInWithPopup(auth, provider);
        }
      } catch (error) {
        showError(error);
      }
    });
    signOutButton.addEventListener("click", async () => {
      try { await signOut(auth); }
      catch (error) { showError(error); }
    });
  } catch (error) {
    console.error("Firebase Authentication could not be initialized.", error);
    signInButton.addEventListener("click", () => window.showAppToast?.("Check the Firebase settings in auth-config.js."));
  }
} else {
  signInButton.addEventListener("click", () => window.showAppToast?.("Google sign-in setup is required. Add the Firebase web-app config and enable Google Authentication."));
}
