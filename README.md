# MiniMax H3 Sprite Studio

MiniMax-H3로 영상을 만들고 같은 로컬 GUI에서 투명 sprite atlas 패키지로 내보내는 오픈소스 도구입니다. MiniMax 공식 제품은 아닙니다.

## 제공 기능

- 참고 이미지 1~9장 또는 시작/종료 프레임으로 MiniMax-H3 영상 생성
- 선택형 스프라이트 구도 제약과 예상 비용 표시
- 생성 상태 조회, MP4 미리보기와 다운로드
- 생성된 MP4 자동 연결 또는 로컬 MP4·MOV·WebM 직접 선택
- 프레임 추출과 GIF 움직임 확인
- BiRefNet 배경 제거 후 atlas PNG/WebP, manifest, Animated WebP, GIF, ZIP 생성
- `workspace/jobs/<job-id>/job.json` 기반 로컬 작업 복구

공식 지원 환경은 macOS Apple Silicon입니다. CUDA와 CPU 실행 경로는 유지하지만 Windows와 Linux는 아직 검증하지 않았습니다.

## 준비

- Node.js 20 이상
- pnpm 10 (Corepack으로 활성화)
- Python 3.10~3.13
- MiniMax API 키와 인터넷 연결

Node GUI에는 별도 npm 의존성이 없습니다. 스프라이트 엔진은 최초 한 번 설치합니다.

```bash
corepack enable pnpm
pnpm setup:sprite
pnpm start
```

`pnpm: command not found`가 나오면 새 터미널을 열거나 현재 터미널에서 `hash -r`을 실행한 뒤 다시 확인하세요.

브라우저에서 [http://127.0.0.1:4317](http://127.0.0.1:4317)을 엽니다. macOS에서는 `start.command`를 더블 클릭해도 됩니다.

`pnpm setup:sprite`는 저장소의 `.venv`에 Python 패키지만 설치합니다. BiRefNet 모델 파일과 원격 코드는 GUI에서 모델을 처음 사용할 때 `workspace/model-cache/`로 내려받습니다. Node GUI는 Gradio를 사용하지 않습니다. `.gradio/`, `.venv/`, `workspace/`의 사용자 작업물·결과물과 일반적인 모델 가중치 파일(`*.ckpt`, `*.pt`, `*.pth`, `*.safetensors`)은 Git에 포함되지 않습니다.

## API 키

우측 상단 `API 설정`에서 입력한 키는 현재 탭 메모리에만 있으며 파일, 쿠키, `localStorage`, `sessionStorage`에 저장하지 않습니다. 환경변수도 사용할 수 있습니다.

```bash
export MINIMAX_API_KEY='발급받은_API_KEY'
pnpm start
```

## 사용 순서

1. 참고 이미지 또는 시작/종료 프레임과 프롬프트를 준비합니다.
2. 설정과 예상 비용을 확인하고 `영상 생성`을 누릅니다.
3. 생성이 끝나면 MP4가 아래 스프라이트 단계에 자동 연결됩니다.
4. 추출 FPS와 최대 프레임을 확인하고 `프레임 펼쳐보기`를 누릅니다.
5. 움직임과 프레임 간격을 확인합니다.
6. BiRefNet 모델, 셀 크기, 열 수와 출력 품질을 정한 뒤 `배경 제거하고 atlas 만들기`를 누릅니다.
7. ZIP 전체 패키지나 필요한 개별 파일을 내려받습니다.

MiniMax 생성이 필요 없다면 스프라이트 단계에서 로컬 영상을 직접 선택할 수 있습니다. 유료 MiniMax 요청, 프레임 추출, 배경 제거는 각각 사용자가 버튼을 눌렀을 때만 시작합니다.

## 결과와 정리 정책

최종 ZIP에는 투명 프레임과 아래 산출물이 포함됩니다.

- `sprite-atlas.png`, `sprite-atlas.webp`
- `sprite-manifest.json`
- `sprite-animation.webp`, `sprite-animation.gif`
- 투명 PNG 프레임

성공하면 작업 폴더의 중간 원본·투명 프레임을 제거합니다. MiniMax로 생성한 MP4와 최종 산출물은 유지하고, 직접 올린 영상은 최종 패키징 뒤 제거합니다. 실패한 작업의 임시 파일은 진단을 위해 남깁니다. GUI의 작업 삭제 기능으로 관련 로컬 파일을 함께 정리할 수 있습니다.

## 모델 실행 경계

BiRefNet은 Hugging Face의 아래 저장소를 고정된 40자리 revision으로 불러오며 `trust_remote_code=True`를 사용합니다.

| 저장소 | 고정 revision |
| --- | --- |
| `ZhengPeng7/BiRefNet_dynamic` | `280306042f57b7a33854319da62fd86aaa89ec4c` |
| `ZhengPeng7/BiRefNet_lite` | `7838f1c3472f827cd8ce13ab5ccc2ce48077360f` |
| `ZhengPeng7/BiRefNet-portrait` | `ecdeb6240ef23557dbd48ff27c59c1a88cbcb755` |
| `ZhengPeng7/BiRefNet_HR-matting` | `5d6b6f8adcb5b417c871b1d84ceaae9871355b7f` |

같은 값은 `lib/sprite-contract.mjs`와 `sprite_engine/birefnet_engine.py`에 기록되어 있습니다. revision 변경은 내려받아 실행할 외부 코드의 변경으로 보고 검토해야 합니다.

## 보안 경계

- 서버는 `127.0.0.1`에만 바인딩합니다.
- API 키, 참고 이미지와 Data URL을 디스크나 작업 manifest에 저장하지 않습니다.
- manifest에는 프롬프트, 생성 설정, MiniMax 작업 ID, 로컬 상대 경로와 스프라이트 설정·결과만 저장합니다.
- 업로드는 MP4·MOV·WebM 및 1GB 이하로 제한합니다.
- 파일 다운로드는 해당 작업 manifest가 허용한 파일만 제공합니다.
- MiniMax가 성공한 작업의 URL만 프록시하며 임의 원격 URL을 받지 않습니다.
- 실제 `영상 생성`을 누르면 MiniMax 잔액이 차감될 수 있습니다.

## 검증

```bash
pnpm check
pnpm test
pnpm test:sprite
```

테스트는 MiniMax API와 BiRefNet 추론을 모킹하므로 유료 요청이나 모델 다운로드를 만들지 않습니다.

## 라이선스

이 프로젝트는 [MIT License](LICENSE)로 배포됩니다. BiRefNet 관련 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인하세요.

## MiniMax 문서

- [MiniMax-H3 Video Generation](https://platform.minimax.io/docs/guides/video-generation)
- [MiniMax-H3 V2 API](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)
- [Pay as You Go](https://platform.minimax.io/docs/guides/pricing-paygo)
