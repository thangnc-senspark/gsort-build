# Unity Build

Build Unity headless (Android APK/AAB, iOS Xcode project) từ git, độc lập với Unity Editor đang dùng, kèm web dashboard theo dõi tiến độ.
Dự án hiện có: **GoodSort**.

## Cách hoạt động
Mỗi job chạy tuần tự các bước sau:
1. **Lấy source từ git**, vào `workspace/<project>/src`:
   - Fetch shallow branch được chọn, `checkout -f`, `git clean -ffdx` (giữ `Library/`), cập nhật submodule.
   - Build đúng code **đã push**. Commit được hiện trên dashboard.
2. **Chép file bí mật** từ `secrets/`, ví dụ keystore.
3. **Inject script build** `unity/BatchBuild.cs` vào `Assets/Editor/UnityBuildSystem/`.
4. **Chọn server test/prod**: sửa `Globals.IsServerProduct`.
5. **Chạy Unity batchmode** (Unity cài trên máy, qua Hub) → `output/<jobId>/`.
   - Android: chạy Android Resolver (EDM), build, ký bằng keystore.
   - iOS: xuất Xcode project, xoá pod Yandex trong `Podfile`, zip lại.

Project gốc và Editor không bị đụng tới. Build có Library riêng trong `workspace/` nên có thể build trong lúc Editor đang mở project.

## Cài đặt
Cần có: macOS, Node ≥ 18, Unity `unityVersion` cùng module Android + iOS cài qua Hub, và **SSH key có quyền đọc repo trên GitHub** (kiểm tra bằng `ssh -T git@github.com`). Key không được đặt passphrase, hoặc đã nạp vào `ssh-agent`: git chạy ở chế độ BatchMode nên không hỏi mật khẩu.

```sh
cp .env.example .env        # điền ANDROID_KEYSTORE_PASS, ANDROID_KEYALIAS_PASS
# secrets/goodsort.keystore phải có sẵn (keystore bị gitignore trong repo game)
npm install
npm start                   # http://localhost:4567
```

Chạy nền: `nohup npm start > server.log 2>&1 &`. Dừng: `kill $(lsof -ti tcp:4567)`.
Mặc định server chỉ nghe trên `127.0.0.1`. Để máy khác cùng mạng truy cập, đặt `HOST=0.0.0.0` trong `.env` rồi mở `http://<IP máy build>:4567`. Dashboard không có đăng nhập: ai trong mạng cũng build và tải APK được.

## Dashboard
- **Build mới**:
  - Branch: dropdown liệt kê toàn bộ branch trên remote, kèm commit đầu branch. Nút **↻ Fetch** lấy lại danh sách mới; danh sách tự cache 60 giây.
  - Server Test/Prod.
  - Platform: Android / iOS / cả hai (chạy tuần tự).
  - Format: APK / AAB / cả hai.
  - Version name/code: để trống thì giữ giá trị trong commit.
  - Tuỳ chọn xoá Library cache.
- **Test license**: mở Unity batchmode trên một project trống rồi thoát.
- **Theo dõi job**:
  - % tổng, các giai đoạn kèm thời gian, bước Unity đang làm.
  - ETA, tính từ lần build thành công trước.
  - Log trực tiếp (có lọc), lỗi được tô đỏ, nút huỷ.
  - Tải file kết quả.
- **Lưu trữ**: log của job nằm ở `jobs/<jobId>/build.log` (thông tin job trong `meta.json`), file build ở `output/<jobId>/`.

## Server test/prod
Cấu hình trong `environments` của `projects/<id>.json`. Mỗi môi trường có `label`, `url` (chỉ để hiển thị) và `patches`. Mỗi patch sửa một file nguồn theo regex.
- GoodSort sửa `Assets/Scripts/Constant/Globals.cs` thành `IsServerProduct = false` (test) hoặc `true` (prod).
- Nếu regex không khớp thì job dừng, để tránh build nhầm server.
- Level được build y như trong git (`Assets/StreamingAssets/LevelData` của commit đó).

## Cấu hình project (`projects/<id>.json`)
| Khoá | Ý nghĩa |
|---|---|
| `unityVersion`, `unityPath` | Phiên bản Unity và đường dẫn (`{version}` được thay) |
| `source.url`, `source.defaultBranch`, `source.submodules` | Repo git (GoodSort dùng SSH: `git@github.com:Senspark/GoodSort.git`) |
| `source.gitConfig` | Cấu hình git áp dụng cho mọi lệnh, kể cả submodule. GoodSort dùng `url.git@github.com:.insteadOf = https://github.com/` để submodule `unity-extension` (khai báo HTTPS trong `.gitmodules`) cũng tải qua SSH |
| `source.extraFiles` | File gitignore cần cho build: `{ "đích trong repo": "nguồn trong unity-build" }` |
| `scenes` | Danh sách scene build (để trống thì dùng EditorBuildSettings) |
| `android.keystore`, `android.outputName` | Keystore (đường dẫn trong repo) và tên file APK/AAB |
| `ios.podfileStripPatterns` | Dòng `Podfile` cần xoá sau khi xuất |
| `defaultEnvironment`, `environments` | Server test/prod (xem phần trên) |

Thêm project mới: tạo file JSON mới theo mẫu `goodsort.json`, rồi restart server.

## Cấu trúc
```
projects/*.json         cấu hình project
unity/BatchBuild.cs     script build inject vào workspace (BuildAndroid / BuildIOS, marker ##UBS cho progress)
server/
  index.js              Express API + SSE, phục vụ dashboard và output/
  jobs.js               hàng đợi job (tuần tự), lưu jobs/<id>/
  sync.js               git fetch/checkout/submodule vào workspace
  environment.js        chọn server test/prod
  unity.js              dựng lệnh Unity, huỷ, xoá Library
  progress.js           đọc log → giai đoạn, %, ETA
  postprocess.js        iOS: xoá dòng Podfile, zip
  public/index.html     dashboard
secrets/                keystore (gitignored)
workspace/              bản checkout + Library riêng (gitignored)
jobs/, output/          lịch sử job và file build (gitignored)
```

## Thời gian build tham khảo (GoodSort, MacBook 8GB RAM)
| Loại | Thời gian |
|---|---|
| Lần đầu (import toàn bộ assets) | 20–40 phút. Phần lớn là Gradle/R8 khi máy thiếu RAM. |
| Build lại Android (đã có Library) | khoảng 3 phút |
| Build lại iOS | khoảng 5 phút |

Đóng Editor và các app nặng khi build để R8 không bị swap.

## Lưu ý
- Docker không dùng được trên Mac Apple Silicon, vì Unity crash dưới Rosetta và license Personal bị từ chối trong container. Vì vậy build chạy bằng Unity cài trên máy.
- `workspace/` chiếm khoảng 15–20 GB, vì `Library/Bee` lớn dần. Tick "Xoá Library cache" để dọn, lần build sau sẽ import lại.
- Xcode project iOS khoảng 1,5 GB mỗi lần build. Xoá các thư mục cũ trong `output/` khi cần.
