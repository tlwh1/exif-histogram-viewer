# EXIF Histogram Viewer

웹페이지에서 이미지를 볼 때 **EXIF 정보와 히스토그램을 바로 확인할 수 있는 Tampermonkey 사용자 스크립트입니다.**

사진을 다운로드하지 않고도 **촬영 정보와 노출 상태를 빠르게 확인**할 수 있습니다.

풍경사진, 인물사진 분석이나 촬영 공부할 때 유용합니다.

---

# 주요 기능

### EXIF 정보 표시
이미지 위에 마우스를 올리면 다음 정보를 확인할 수 있습니다.

- 카메라 모델
- 렌즈 정보
- ISO
- 조리개
- 셔터스피드
- 초점거리

### 히스토그램 표시
사진의 노출 분포를 확인할 수 있습니다.

- 하이라이트 클리핑 확인
- 암부 손실 확인
- 전체 노출 상태 파악

### Hover 방식
이미지에 마우스를 올리면 자동으로 정보가 표시됩니다.

### 브라우저에서 바로 작동
별도 프로그램 없이 **크롬 + Tampermonkey만 설치하면 사용 가능**합니다.

---

# 설치 방법

## 1️⃣ Tampermonkey 설치

크롬에서 Tampermonkey 확장프로그램을 설치합니다.

https://tampermonkey.net/

---

## 2️⃣ 스크립트 설치

아래 링크를 클릭하면 설치 화면이 열립니다.

**Install**

https://raw.githubusercontent.com/tlwh1/exif-histogram-viewer/main/exif-histogram-viewer.user.js

설치 화면에서 **Install 버튼을 누르면 완료됩니다.**

---

# 사용 방법

1. 웹페이지에서 사진이 있는 페이지로 이동
2. 이미지 위에 마우스를 올리기
3. EXIF 정보와 히스토그램 확인

---

# 요구 사항

- Google Chrome
- Tampermonkey 확장프로그램

---

# License

MIT License

---

# Author

tlwh1