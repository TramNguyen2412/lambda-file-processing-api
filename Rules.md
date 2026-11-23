Rules

    Không sử dụng S3, database, frontend hoặc presigned URL.

    Không tự ý thay đổi architecture hoặc mở rộng scope.

    Không hardcode AWS credentials, secrets hoặc thông tin account.

    Không tự ý thực hiện AWS deployment, tạo resource, sửa resource hoặc xóa resource khi chưa được tôi xác nhận.

    Ưu tiên code đơn giản, dễ đọc và dễ giải thích cho người mới học AWS.

    Không chỉ copy code trong plan một cách máy móc. Kiểm tra tính đúng đắn, sửa lỗi cần thiết và đảm bảo code hoạt động.

    Nếu plan có vấn đề hoặc AWS CLI command không chính xác, hãy báo lại và đề xuất sửa trước khi thực hiện.

    Không bỏ qua lỗi bằng cách sử dụng || true một cách indiscriminate.

Phase 1: Project setup và implementation

Trước tiên:

    Kiểm tra repository, branch, remote và các file hiện có.

    Đọc toàn bộ PLAN.md.

    Kiểm tra Node.js, npm và TypeScript environment.

    Tạo package.json, tsconfig.json và .gitignore phù hợp.

Implement các components theo plan:

    Health handler.

    Info handler.

    Excel upload và parsing handler.

    Excel generation handler.

    Response streaming handler dành riêng cho Lambda Function URL RESPONSE_STREAM.

    Excel generator và parser utilities.

    Scripts generate test files.

    Scripts build và package Lambda.

Tạo đầy đủ project structure theo plan.
Phase 2: Local verification

Trước khi làm AWS deployment:

    Cài dependencies.

    Build TypeScript.

    Kiểm tra toàn bộ compile errors.

    Sửa các lỗi TypeScript và compatibility với Node.js 24.

    Kiểm tra package contents và Lambda handler paths.

    Kiểm tra package scripts hoạt động.

    Kiểm tra .gitignore, đảm bảo không commit node_modules, generated files, test files lớn hoặc credentials.

    Nếu có thể, test logic generate/parse Excel locally.

Không được báo code hoàn thành nếu build chưa thành công.
Phase 3: Review deployment scripts

Tạo và review các AWS CLI scripts theo PLAN.md:

    IAM role.

    Lambda functions.

    API Gateway HTTP API.

    Lambda Function URLs.

    Cleanup.

Kiểm tra:

    Resource names.

    AWS region và profile.

    IAM permissions.

    Lambda runtime nodejs24.x.

    Timeout và memory configurations.

    API Gateway integration và routes.

    Function URL invoke permissions.

    Scripts có khả năng chạy lại mà không tạo duplicate resources.

    Cleanup chỉ xóa đúng resources của project này.

Chưa chạy các scripts này và chưa tạo AWS resources.
Phase 4: Final review

Sau khi hoàn thành code, hãy trả về:

    Danh sách file đã tạo.

    Architecture đã implement.

    Những điểm khác biệt so với PLAN.md và lý do.

    Build/test results.

    Các lỗi đã phát hiện và sửa.

    Những phần chưa hoàn thành.

    Các AWS CLI commands cần chạy tiếp theo, theo thứ tự.

    Những AWS resources sẽ được tạo và estimated cost/risk nếu có.

    Git status và những file nên commit.

Dừng lại sau khi hoàn thành local implementation và review. Chờ tôi xác nhận trước khi deployment lên AWS.