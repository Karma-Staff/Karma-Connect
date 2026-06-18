// Read the signed-in user's AI usage/cost (recorded server-side per call). No AI tokens used.
import { getAccessToken } from "./auth.js";

export async function getUsage() {
  const token = getAccessToken();
  const res = await fetch("/api/usage", { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) throw new Error("Could not load usage.");
  return res.json(); // { totals, month, byKind }
}
