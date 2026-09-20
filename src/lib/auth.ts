import { supabase } from "./supabase";

export async function ensureAnonymousSession() {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

  if (sessionError) throw sessionError;
  if (sessionData.session) return sessionData.session;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  if (!data.session) throw new Error("익명 사용자 정보를 만들지 못했어요.");

  return data.session;
}
