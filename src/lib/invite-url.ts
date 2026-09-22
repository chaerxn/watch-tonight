function inviteCodeFromUrl(value: string): string | null {
  try {
    const params = new URL(value).searchParams;
    const directCode = params.get("invite") ?? params.get("code");
    if (directCode) return directCode;

    const nestedParams = params.get("queryParams");
    if (!nestedParams) return null;

    const parsed: unknown = JSON.parse(nestedParams);
    if (!parsed || typeof parsed !== "object") return null;

    const values = parsed as Record<string, unknown>;
    const nestedCode = values.invite ?? values.code;
    return typeof nestedCode === "string" && nestedCode.length > 0 ? nestedCode : null;
  } catch {
    return null;
  }
}

export function getInitialInviteCode(browserUrl: string, schemeUrl?: string): string | null {
  return inviteCodeFromUrl(browserUrl) ?? (schemeUrl ? inviteCodeFromUrl(schemeUrl) : null);
}
