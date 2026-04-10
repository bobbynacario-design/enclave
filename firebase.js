// firebase.js — Firebase v9 modular SDK initialization
// Replace the placeholder config values with your real Firebase project credentials.

import { initializeApp }                from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js';
import { getAuth, GoogleAuthProvider }  from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import { getFirestore }                 from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { getStorage }                   from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-storage.js';

const firebaseConfig = {
  apiKey:            'AIzaSyBC8nqTgaqMp0R45dnKpA44u0S5C3nnbFE',
  authDomain:        'enclave-social.firebaseapp.com',
  projectId:         'enclave-social',
  storageBucket:     'enclave-social.firebasestorage.app',
  messagingSenderId: '834210326738',
  appId:             '1:834210326738:web:61e6ebc4ca892c42dc650b',
  measurementId:     'G-MENSBLG4SS'
};

const app = initializeApp(firebaseConfig);

export const auth           = getAuth(app);
export const db             = getFirestore(app);
export const storage        = getStorage(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('https://www.googleapis.com/auth/drive.readonly');
