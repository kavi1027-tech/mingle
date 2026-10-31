import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js";

const config = window.FIREBASE_CONFIG || {};
const required = ["apiKey", "authDomain", "projectId", "appId", "databaseURL"];
const missing = required.filter((key) => typeof config[key] !== "string" || !config[key].trim());

export const isFirebaseConfigured = missing.length === 0;

export async function initializeMingle() {
  if (!isFirebaseConfigured) {
    throw new Error(`Live service setup is incomplete. Add ${missing.join(", ")} to auth-config.js.`);
  }

  const app = initializeApp(config);
  const auth = getAuth(app);
  const user = auth.currentUser || (await signInAnonymously(auth)).user;
  const database = getDatabase(app, config.databaseURL);
  const functions = getFunctions(app, config.functionsRegion || "us-central1");

  const call = async (name, data = {}) => {
    const callable = httpsCallable(functions, name);
    const result = await callable(data);
    return result.data;
  };

  return { app, auth, user, database, call };
}
