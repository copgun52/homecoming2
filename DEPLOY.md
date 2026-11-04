# 배포 방법 (Fly.io + GitHub 자동 배포)

처음 한 번만 하면, 그다음부터는 코드를 GitHub에 올릴 때마다 자동으로 배포돼요.
계정 가입과 결제 정보 입력은 본인이 직접 해야 해요.

## 1. 준비물
- GitHub 계정, Fly.io 계정 (Fly는 결제 수단 등록이 필요할 수 있어요)
- flyctl 설치: https://fly.io/docs/flyctl/install/

## 2. Fly 앱과 디스크 만들기 (한 번만)
```bash
fly auth login
fly apps create 내가정한앱이름
fly volumes create data --size 1 --region nrt
```
`fly.toml`의 `app = "..."`을 위에서 정한 이름으로 바꾸세요.
디스크(`data`)는 서버 1대에 붙어요. 이 서비스는 서버를 1대만 운영해요.

## 3. 첫 배포 (한 번만, 내 PC에서)
```bash
fly deploy --ha=false
```
끝나면 `https://내가정한앱이름.fly.dev` 로 접속돼요.

## 4. 자동 배포 켜기
1. 이 폴더를 GitHub 저장소(비공개 추천)로 올려요. `data.json`과 `node_modules`는 `.gitignore`로 제외돼요.
2. 배포용 토큰을 만들어요.
   ```bash
   fly tokens create deploy
   ```
3. GitHub 저장소 → Settings → Secrets and variables → Actions → `FLY_API_TOKEN` 이름으로 토큰을 저장해요.
4. 이제 `main` 브랜치에 코드를 올리면 `.github/workflows/deploy.yml`이 자동으로 배포해요.

## 기록은 어디에 저장되나요
- 사람들이 남긴 글과 등불은 서버 디스크의 `/data/data.json`에 저장돼요. 재배포해도 남아요.
- 하루에 한 번 `/data/data-날짜.bak.json` 백업이 생기고 최근 14개를 보관해요.
- 서버가 꺼질 때 마지막으로 저장하고, 파일이 깨져 있으면 덮어쓰지 않고 멈춰요.
- 디스크 자체가 사고로 사라질 수 있으니, 가끔 `fly ssh sftp get /data/data.json` 으로 내려받아 따로 보관하세요.

## 한도
- 동시 접속 최대 100명 (`server.js`의 `MAX_PLAYERS`). 가득 차면 "마을이 가득 찼어요"가 떠요.
