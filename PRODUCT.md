# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

로컬에서 MiniMax-H3로 짧은 영상을 만들고, 같은 도구 안에서 게임·앱용 투명 스프라이트 atlas로 변환하려는 제작자와 개발자.

## Product Purpose

MiniMax-H3 영상 생성과 로컬 BiRefNet 배경 제거·프레임 추출·sprite atlas 패키징을 하나의 GUI로 연결한다. 사용자는 생성된 MP4 또는 직접 업로드한 MP4·MOV·WebM을 입력으로 삼아 atlas PNG/WebP, manifest, 애니메이션 WebP/GIF와 ZIP 패키지를 만들 수 있다.

## Positioning

유료 원격 영상 생성과 무거운 로컬 투명화·atlas 변환을 분리하면서도, 작업 상태와 결과 파일을 하나의 로컬 작업 단위로 이어 주는 오픈소스 제작 도구다.

## Operating Context

- 공식 지원 환경은 macOS Apple Silicon이다. CUDA와 CPU 실행 경로는 유지하지만 Windows와 Linux는 미검증으로 표시한다.
- Node.js 20 이상이 GUI와 MiniMax 프록시를 실행한다.
- `pnpm setup:sprite`가 프로젝트 내부 `.venv`를 만들고 Python 3.10-3.13용 스프라이트 의존성을 설치한다.
- MiniMax 요청에는 인터넷과 사용자 API 키가 필요하다. BiRefNet 모델은 처음 선택할 때 고정된 Hugging Face revision에서 내려받는다.
- 앱은 `127.0.0.1`에서만 열리며 작업 파일은 Git에서 제외된 `workspace/jobs/`에 저장한다.

## Capabilities and Constraints

- MiniMax 작업 하나가 독립적인 스프라이트 작업 하나와 atlas 하나로 이어진다.
- MiniMax 생성 성공 후 MP4만 스프라이트 입력에 연결한다. 프레임 추출과 배경 제거는 사용자가 각각 명시적으로 시작한다.
- 스프라이트 입력은 연결된 H3 영상과 직접 업로드한 로컬 영상을 모두 지원한다.
- 스프라이트 설정은 접지 않고 모두 표시한다: 추출 FPS, 최대 프레임, 셀 크기, atlas 열 수, BiRefNet 모델, 가장자리 정제, WebP 품질, GIF 색상 수.
- 기본값은 15 FPS, 최대 120프레임, 256px 셀, 10열, WebP 품질 80, GIF 128색이다.
- 생성 MP4와 최종 결과는 유지한다. 성공한 작업의 중간 원본·투명 프레임은 ZIP에 포함한 뒤 작업 폴더에서 제거한다. 실패한 작업의 임시 파일은 진단을 위해 유지한다.
- 작업 상태는 `workspace/jobs/<job-id>/job.json`으로 복구하며 별도 데이터베이스를 사용하지 않는다.
- API 키와 참고 이미지·Data URL은 디스크에 저장하지 않는다. 프롬프트, 생성 설정, MiniMax 작업 ID, 파일 경로와 스프라이트 설정·결과만 manifest에 저장한다.
- 직접 업로드한 영상은 성공적인 최종 패키징 뒤 제거한다.
- BiRefNet 모델 코드는 고정 revision과 `trust_remote_code=True`를 사용한다. revision 변경은 검토 대상이며 최초 다운로드·외부 코드 실행 경계를 문서와 GUI에 표시한다.

## Brand Commitments

- 제품명은 `MiniMax H3 Sprite Studio`다.
- GitHub 저장소 이름은 `minimax-h3-studio`를 유지한다.
- MiniMax 공식 제품이 아닌 로컬 오픈소스 도구임을 공개 문서와 화면에 표시한다.
- 기존의 차분한 다크 도구 인터페이스와 직접적인 한국어 문체를 유지한다.

## Evidence on Hand

- MiniMax 요청 검증과 프록시 계약: `lib/h3-contract.mjs`, `server.mjs`, `test/`.
- 검증된 로컬 영상 변환 계약: `video-to-sprite-animation`의 `sprite_pipeline.py`와 BiRefNet 엔진.
- 기존 변환 결과 계약: atlas PNG/WebP, manifest JSON, 애니메이션 WebP/GIF, 투명 프레임을 포함한 ZIP.
- 실제 Windows/Linux 통합 검증과 실제 MiniMax 유료 생성은 이번 구현의 증거 범위에 포함되지 않는다.

## Product Principles

- 유료 생성과 무거운 로컬 처리는 사용자의 명시적 행동으로 시작한다.
- 입력 비밀과 참고 이미지는 저장하지 않고, 공개 Git에는 코드·문서·테스트만 남긴다.
- 하나의 작업이 영상, 변환 설정과 최종 파일을 끝까지 연결한다.
- 부드러운 알파 기준본은 PNG/WebP이며 GIF는 미리보기 호환물로 취급한다.
- 공식 지원과 미검증 가능성을 구분해 설명한다.

## Accessibility & Inclusion

키보드로 모든 주요 동작을 실행할 수 있어야 하며, 상태·진행·오류는 색상만으로 구분하지 않는다. 좁은 화면에서도 단계 순서가 유지되고 `prefers-reduced-motion`을 존중한다.
