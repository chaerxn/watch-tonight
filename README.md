# 오늘 뭐 볼래? (Watch Tonight)

친구나 연인이 보고 싶은 작품을 함께 모으고 평가해 오늘 볼 한 편을 정하는 Apps in Toss 웹앱입니다.

## 로컬 실행

1. 의존성을 설치합니다.

   ```bash
   npm install
   ```

2. `.env.example`을 참고해 `.env.local`을 만들고 Supabase 공개 연결값을 입력합니다.

3. 개발 서버를 실행합니다.

   ```bash
   npm run dev
   ```

## 검사

```bash
npm run lint
npm run build
```

## 구성

- React + TypeScript + Vite
- Apps in Toss Web Framework
- Supabase Auth, Database, Realtime, Edge Functions
- TMDB Search API

비밀키와 실제 환경변수는 저장소에 포함하지 않습니다. TMDB 토큰은 클라이언트가 아닌 Supabase Edge Function의 환경변수로 설정해야 합니다.
