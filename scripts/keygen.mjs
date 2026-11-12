// Prints a fresh key pair as "<secret> <public>".
import { generateKey } from "../web/near-lite.js";
const k = await generateKey();
console.log(k.secret + " " + k.publicKey);
