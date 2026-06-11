// Supabase client for team login. If the env vars are absent (e.g. quick local dev),
// the app runs without a login gate and the dev proxy serves AI calls.
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = !!(url && anon);
export const supabase = supabaseConfigured ? createClient(url, anon) : null;

// Cache the current access token so the API client can attach it without async work.
let accessToken = null;
if (supabase) {
  supabase.auth.getSession().then(({ data }) => { accessToken = data.session?.access_token || null; });
  supabase.auth.onAuthStateChange((_event, session) => { accessToken = session?.access_token || null; });
}

export function getAccessToken() {
  return accessToken;
}
