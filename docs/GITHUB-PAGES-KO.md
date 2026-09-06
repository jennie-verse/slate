# GitHub Pages 배포와 업데이트

저장소: `jennie-verse/slate` · 배포 주소: `https://jennie-verse.github.io/slate/`

저장소 이름과 배포 주소는 **한 번 정하면 바꾸지 않습니다.** 홈 화면에 추가한 앱의 주소가 바뀌면 기존 데이터에 접근할 수 없게 됩니다.

---

## 1. 처음 배포

### 1-1. 저장소 만들기

1. GitHub에서 **New repository**
2. Repository name: **`slate`**
3. **Public** 을 고릅니다 (Pages 무료 버전은 공개 저장소가 필요합니다)
4. README·.gitignore·license는 **추가하지 않습니다** (이미 폴더 안에 있습니다)
5. **Create repository**

### 1-2. 파일 올리기

`slate` 폴더 **안의 내용**을 올립니다. `slate` 폴더 자체를 통째로 올리면 주소가 `/slate/slate/`가 됩니다.

```bash
cd slate
git init
git add -A
git commit -m "slate stage 1"
git branch -M main
git remote add origin https://github.com/jennie-verse/slate.git
git push -u origin main
```

> `.nojekyll` 파일이 반드시 함께 올라가야 합니다. 없으면 GitHub가 밑줄로 시작하는 경로를 걸러내고 일부 파일이 404가 됩니다. 숨김 파일이라 웹 화면에서 끌어다 놓으면 빠지기 쉽습니다 — 위 `git add -A` 방식이면 안전합니다.

### 1-3. Pages 켜기

1. 저장소 → **Settings** → 왼쪽 **Pages**
2. Source: **Deploy from a branch**
3. Branch: **main**, 폴더: **/ (root)**
4. **Save**
5. 1~2분 뒤 `https://jennie-verse.github.io/slate/` 가 열립니다

### 1-4. 확인

- 주소가 실제로 열리는지
- 브라우저 콘솔에 오류가 없는지
- Safari에서 **홈 화면에 추가**가 되는지
- 비행기 모드로 바꾼 뒤에도 앱이 열리는지 (Service Worker 확인)

---

## 2. 업데이트

### 2-1. 반드시 함께 바꿔야 하는 두 곳

Service Worker를 고쳤다면 — 아니, **파일을 하나라도 고쳤다면** 아래 두 값을 같은 값으로 올립니다.

| 파일 | 값 |
|---|---|
| `sw.js` | `const VERSION = "..."` |
| `src/version.js` | `export const APP_BUILD = "..."` |

형식은 `2026.08.13-stage1` 처럼 날짜와 짧은 이름입니다.

**이걸 빠뜨리면 고친 내용이 기기에 나타나지 않습니다.** Service Worker가 옛 파일을 캐시에서 먼저 내주기 때문입니다. `tests/static.test.mjs`가 두 값이 어긋나면 실패하도록 되어 있으니, 올리기 전에 테스트를 돌리세요.

```bash
npm test
```

### 2-2. 올리기

```bash
git add -A
git commit -m "무엇을 고쳤는지"
git push
```

### 2-3. 기기에서 새 버전 받기

1. 홈 화면 앱을 완전히 종료합니다 (앱 전환기에서 위로 밀어 올림)
2. 다시 엽니다
3. **설정(Settings)** 을 열어 **Build** 값이 방금 올린 값인지 확인합니다

값이 그대로면 캐시가 남은 것입니다 — [TROUBLESHOOTING-KO.md](./TROUBLESHOOTING-KO.md)의 "업데이트가 안 보임"을 보세요.

---

## 3. 파일 구조

```
slate/
├─ .nojekyll                Jekyll 처리 끄기 — 반드시 포함
├─ index.html               CSP·메타·매니페스트 선언
├─ manifest.webmanifest     PWA 정보 (orientation 없음 = 가로·세로 모두)
├─ sw.js                    Service Worker. VERSION을 version.js와 맞춤
├─ assets/
│   ├─ app.css              하우스 토큰 (--fs, --tap, --safe-*, --rose-on)
│   └─ fonts/               lexend-400 / lexend-700 / virgil
├─ vendor/                  rough.esm.js (27.7KB) · perfect-freehand.mjs (4.5KB)
├─ src/                     앱 코드
│   ├─ actions.js  ★ 요소 변경의 단일 통로
│   ├─ registry.js ★ 요소 타입별 그리기 등록표
│   ├─ geometry.js ★ DOM을 쓰지 않는 순수 기하 계산
│   ├─ ordering.js ★ fractional index
│   ├─ migrate.js  ★ 스키마 버전 러너
│   └─ tools/               도구 10가지
├─ icons/                   180 / 192 / 512 / apple-touch-icon / icon.svg
├─ licenses/                동봉 라이브러리·글꼴 라이선스 원문
├─ tests/                   node --test 로 실행
├─ docs/                    이 문서들
└─ THIRD_PARTY_NOTICES.md
```

★ 표시는 지금 당장은 없어도 되지만 나중에 넣으면 재작성이 되는 확장 지점입니다. 계획서 3-5장·5장을 보세요.

---

## 4. 색·글꼴·이름을 바꾸고 싶을 때

| 바꿀 것 | 위치 |
|---|---|
| UI 색 전체 | `assets/app.css` 의 `:root` / `[data-theme="dark"]` 토큰 |
| 캔버스 선·채움 팔레트 | `src/model.js` 의 `STROKE_PALETTE` · `FILL_PALETTE` |
| 캔버스 배경 후보 | `src/model.js` 의 `CANVAS_BACKGROUNDS` |
| 앱 이름 | `manifest.webmanifest` 의 `name` · `short_name`, `index.html` 의 `<title>` |
| 아이콘 | `icons/icon.svg` 를 고친 뒤 180·192·512 PNG를 다시 만듭니다 |
| 기본 글자 크기 단계 | `src/settings.js` 의 `FONT_STEPS` |

색을 바꿀 때는 **`--rose-on`을 함께 확인하세요.** 대표색 위에 얹히는 글자 전용 토큰이고, 다크 모드에서 `--rose-ink`와 값이 다릅니다. 둘을 섞어 쓰면 대비가 무너집니다.

---

## 5. 배포 후 폴더 정리

`Published/slate/`가 GitHub 저장소와 배포의 유일한 수정 원본입니다. 배포 주소와 GitHub Actions 성공을 확인한 뒤 workflow가 허용한 runtime 파일만 `Deliverable/slate/`와 `Backup/slate/`에 읽기 전용 스냅샷으로 다시 만듭니다. 폴더를 서로 이동하거나 Deliverable을 직접 수정하지 않습니다.
