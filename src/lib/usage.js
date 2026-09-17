// Read the signed-in user's AI usage/cost (recorded server-side per call). No AI tokens used.

export async function getUsage() {
  const res = await fetch("/api/usage");
  if (!res.ok) throw new Error("Could not load usage.");
  return res.json(); // { totals, month, byKind }
}
