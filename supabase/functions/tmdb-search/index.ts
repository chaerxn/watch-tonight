import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

type SearchItem = Record<string, unknown> & {
  id: number;
  media_type: "movie" | "tv";
};

type WatchProvider = {
  provider_id?: number;
  provider_name?: string;
  display_priority?: number;
};

const providerGroups = ["flatrate", "free", "ads", "rent", "buy"] as const;

async function getKoreanWatchProviders(item: SearchItem, token: string) {
  try {
    const url = new URL(
      `https://api.themoviedb.org/3/${item.media_type}/${item.id}/watch/providers`,
    );
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      console.error("TMDB watch providers request failed", response.status, item.media_type, item.id);
      return [];
    }

    const data = await response.json();
    const koreanProviders = data?.results?.KR;
    if (!koreanProviders) return [];

    const providers = providerGroups.flatMap((group) => {
      const groupProviders = koreanProviders[group];
      return Array.isArray(groupProviders) ? groupProviders : [];
    }) as WatchProvider[];
    const uniqueProviders = new Map<number, WatchProvider>();

    providers
      .sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999))
      .forEach((provider) => {
        if (
          typeof provider.provider_id === "number" &&
          typeof provider.provider_name === "string" &&
          !uniqueProviders.has(provider.provider_id)
        ) {
          uniqueProviders.set(provider.provider_id, provider);
        }
      });

    return [...uniqueProviders.values()].map((provider) => provider.provider_name as string);
  } catch (error) {
    console.error(
      "TMDB watch providers error",
      item.media_type,
      item.id,
      error instanceof Error ? error.message : "Unknown error",
    );
    return [];
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "POST 요청만 지원해요." }, 405);
  }

  try {
    const authorization = request.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const publishableKeys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    const publishableKey = publishableKeys.default;

    if (!authorization || !supabaseUrl || !publishableKey) {
      return json({ error: "사용자 확인이 필요해요." }, 401);
    }

    const supabase = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser();

    if (userError || !userData.user) {
      return json({ error: "사용자 확인이 필요해요." }, 401);
    }

    const token = Deno.env.get("TMDB_READ_ACCESS_TOKEN");
    if (!token) {
      return json({ error: "영화 검색 설정이 완료되지 않았어요." }, 500);
    }

    const body = await request.json();
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const requestedPage = Number.isInteger(body.page) ? body.page : 1;
    const page = Math.min(Math.max(requestedPage, 1), 500);

    if (query.length < 2 || query.length > 80) {
      return json({ error: "검색어는 2자 이상 80자 이하로 입력해 주세요." }, 400);
    }

    const url = new URL("https://api.themoviedb.org/3/search/multi");
    url.searchParams.set("query", query);
    url.searchParams.set("include_adult", "false");
    url.searchParams.set("language", "ko-KR");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      console.error("TMDB request failed", response.status);
      return json({ error: "작품 정보를 불러오지 못했어요." }, 502);
    }

    const data = await response.json();
    const searchItems = Array.isArray(data.results)
      ? (data.results.filter(
          (item: unknown) =>
            typeof item === "object" &&
            item !== null &&
            (item as Record<string, unknown>).media_type !== "person" &&
            ((item as Record<string, unknown>).media_type === "movie" ||
              (item as Record<string, unknown>).media_type === "tv") &&
            typeof (item as Record<string, unknown>).id === "number",
        ) as SearchItem[])
      : [];
    const results = [];

    for (let index = 0; index < searchItems.length; index += 5) {
      const batch = searchItems.slice(index, index + 5);
      const batchResults = await Promise.all(
        batch.map(async (item) => {
            const isMovie = item.media_type === "movie";
            return {
              id: item.id,
              mediaType: item.media_type,
              title: isMovie ? item.title : item.name,
              originalTitle: isMovie ? item.original_title : item.original_name,
              releaseDate: (isMovie ? item.release_date : item.first_air_date) || null,
              overview: item.overview || "",
              posterPath: item.poster_path || null,
              genreIds: Array.isArray(item.genre_ids) ? item.genre_ids : [],
              watchProviders: await getKoreanWatchProviders(item, token),
            };
          }),
      );
      results.push(...batchResults);
    }

    return json({
      page: data.page || page,
      totalPages: data.total_pages || 0,
      totalResults: results.length,
      results,
    });
  } catch (error) {
    console.error("TMDB search error", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "작품 검색 중 문제가 생겼어요." }, 500);
  }
});
