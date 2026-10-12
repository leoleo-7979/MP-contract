# 계약서 관리 웹앱

## 준비 (한 번만)
1. 구글 서비스계정(기존 매니저시스템에서 쓰는 것과 같은 것 가능)의 이메일에 공유:
   - 계약기간 시트: 뷰어
   - 드라이브 "계약서모음" 폴더: 편집자 (결과 파일을 '작업완료' 폴더에 저장하려면 편집 권한 필요)
2. 서버 설정(환경변수). 키는 서버 설정에만 넣고 파일·채팅에 붙여 넣지 마세요.
   - APP_PASSWORD        접속 비밀번호 (필수)
   - SESSION_SECRET      아무 긴 무작위 문자열
   - GOOGLE_SERVICE_ACCOUNT_JSON  서비스계정 키 JSON 전체 (또는 GOOGLE_APPLICATION_CREDENTIALS=키 파일 경로)
   - SHEET_ID            1YUhnvT0YmazyxD18Knc4jsM97XjG3u6wCEs52K3he7k
   - SHEET_TAB           계약기간
   - DRIVE_FOLDER_ID     계약서모음 폴더 주소 끝의 ID
   - OUTPUT_FOLDER_ID    (선택) 결과 저장 폴더. 비우면 계약서모음 안에 '작업완료' 폴더를 만듭니다
   - PORT                (선택) 기본 3000
3. 실행: `npm install` 후 `npm start`

## 쓰는 법
- 처음 열면 시트와 계약서를 자동으로 읽습니다(계약서가 많으면 1~2분).
- 재직자 갱신: D-숫자 입력 → 사람 선택 → 개월 수 → "계약서 만들기" → 확인 화면에서 바뀐 곳 확인 → 내려받기/드라이브 저장
- 신규 입사: D데이가 "신규"인 행. 칸을 고쳐 쓸 수 있고, 본보기 계약서는 자동 또는 직접 선택.
- 계약서 파일은 드라이브 폴더 안에서 "이름 + 현재 계약기간"으로 찾습니다. 시트와 기간이 다르면 제외되고 이유가 표시됩니다.

## 테스트 모드 (구글 없이)
MOCK=1 MOCK_SHEET=시트.csv MOCK_DIR=계약서폴더 APP_PASSWORD=아무거나 npm start
