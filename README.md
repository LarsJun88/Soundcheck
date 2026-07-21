# Soundcheck — 합주실 스케줄러

한 개의 합주실을 여러 밴드가 함께 쓰기 위한 Firebase 웹 앱입니다. 정적 페이지는 Firebase Hosting(또는 GitHub Pages)으로 공개하고, 실제 데이터·로그인·예약 충돌 방지·텔레그램 알림은 Firebase에서 처리합니다.

## 포함된 기능

- 누구나 로그인 전 메인 화면에서 공지사항과 7일 시간표 확인
- Firebase Authentication 이메일/비밀번호 로그인 — 밴드 관리자가 비밀번호를 직접 설정
- 메인 관리자만 밴드와 밴드 관리자 초대 코드 생성
- 초대받은 이메일로만 코드를 사용해 밴드 관리자 권한 활성화
- 1시간 단위 예약, 운영 시간 설정, 동시에 들어온 예약의 서버 측 충돌 차단
- 밴드 관리자는 자기 밴드 예약만 생성/취소, 메인 관리자는 전체 관리
- Firestore Security Rules로 브라우저의 직접 예약/권한 변경 차단

## 시작 전 준비

1. [Firebase Console](https://console.firebase.google.com/)에서 프로젝트와 **Web app**을 하나 만듭니다.
2. **Authentication → Sign-in method → Email/Password**를 활성화합니다.
3. **Firestore Database**를 Production mode로 생성합니다. 리전은 Functions와 가까운 `asia-northeast3`(서울)을 권장합니다.
4. Firebase 프로젝트는 Cloud Functions를 쓰므로 Blaze(종량제) 요금제가 필요합니다. 작은 합주실 사용량에서는 Scheduler 1개와 Functions 호출 비용이 매우 작습니다.
5. 로컬에 [Node.js 20](https://nodejs.org/)와 Firebase CLI를 설치하고 로그인합니다.

```bash
npm install -g firebase-tools
firebase login
firebase use --add
npm install --prefix functions
```

## Firebase 웹 설정

Firebase Console의 **프로젝트 설정 → 내 앱 → SDK setup and configuration** 값을 아래 파일에 입력합니다.

```powershell
Copy-Item public/firebase-config.js.example public/firebase-config.js
```

`public/firebase-config.js`의 `YOUR_...` 값을 모두 실제 값으로 바꾸세요. 이 파일은 `.gitignore`에 있으므로 저장소에 개인 프로젝트 설정이 커밋되지 않습니다.

> `apiKey`를 포함한 Firebase Web config는 웹 앱에서 공개되는 식별자입니다. 실제 접근 제어는 이 프로젝트의 `firestore.rules`와 Firebase Authentication이 담당합니다.

## 최초 메인 관리자 설정

배포 전에 최초 등록용 비밀 코드를 설정합니다. 이 값은 브라우저나 GitHub에 절대 올리지 마세요.

```bash
firebase functions:secrets:set BOOTSTRAP_CODE
```

배포 후 메인 관리자 본인이 사이트에서 **계정 만들기**로 이메일/비밀번호 계정을 만든 뒤, 로그인 화면의 **최초 메인 관리자 등록**에 이 코드를 입력합니다. 한 번 등록되면 다시 사용할 수 없습니다.

그 뒤 운영 관리에서 밴드 이름과 관리자 이메일을 등록하면 10자리 초대 코드가 나옵니다. 그 코드를 해당 관리자에게 전달하면, 관리자가 자신의 이메일과 원하는 비밀번호로 계정을 생성해 활성화할 수 있습니다.


## 배포와 GitHub

```bash
firebase deploy
```

배포가 완료되면 Firebase Hosting URL로 접속할 수 있습니다. GitHub에 올릴 때는 `public/firebase-config.js`가 무시되는지 확인하고, 예시 파일만 커밋하세요.

```bash
git add .
git commit -m "feat: add Firebase rehearsal room scheduler"
git remote add origin https://github.com/ACCOUNT/REPOSITORY.git
git push -u origin main
```

### GitHub Actions로 자동 배포하고 싶다면

Firebase Console에서 `firebase init hosting:github`를 실행하면 Firebase CLI가 GitHub Actions 워크플로와 필요한 저장소 Secret을 대화형으로 추가합니다. 이 프로젝트는 `firebase.json`을 이미 포함하므로 Firebase가 안내하는 GitHub 연결 절차를 그대로 따르면 됩니다.

## 개발 실행

Firebase Emulator를 사용하면 실제 데이터와 알림을 건드리지 않고 테스트할 수 있습니다.

```bash
firebase emulators:start --only hosting,functions,firestore
```

Functions 배포 후 로그인, 밴드 초대, 예약 흐름을 확인하세요.

## 데이터 구조

| 컬렉션 | 역할 |
| --- | --- |
| `users` | 역할과 밴드 소속 (서버만 작성) |
| `bands` | 밴드와 담당 관리자 |
| `reservations` | 확정/취소된 예약 기록 |
| `scheduleSlots` | 시간별 잠금 문서 — 겹침 방지용 |
| `announcements` | 메인 화면 공지 |
| `settings/room` | 운영 시작·마감 시간, 60분 단위 설정 |

`scheduleSlots`와 예약 데이터는 Cloud Function 트랜잭션으로 함께 생성됩니다. 따라서 두 명이 같은 시간을 동시에 누르더라도 한 명만 예약에 성공합니다.
