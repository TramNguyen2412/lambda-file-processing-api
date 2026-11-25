# Báo cáo Thực nghiệm: Triển khai và Khảo sát Giới hạn Kiến trúc trên AWS Serverless

> **Dự án:** AWS Lambda File Processing API  
> **Môi trường thực thi:** Node.js 24.x (`nodejs24.x`), TypeScript, AWS Lambda, API Gateway HTTP API, Lambda Function URLs  
> **Phạm vi báo cáo:** Toàn bộ quá trình triển khai hạ tầng, kiểm thử ranh giới và đo lường hiệu năng chuyên sâu từ Giai đoạn 01 đến Giai đoạn 06 (`infra/01-iam.sh` → `infra/06-benchmark.sh`)  
> **Trạng thái thực nghiệm:** 21/21 kịch bản kiểm thử đạt chuẩn (PASS) ở Giai đoạn 05 và hoàn thành các phép đo hiệu năng Giai đoạn 06 (TEST A, B, C, D)  

> **Quy ước đơn vị & ký hiệu số trong báo cáo:**  
> * **MB (Megabyte, hệ thập phân):** $1\text{ MB} = 1{,}000{,}000\text{ bytes}$.  
> * **MiB (Mebibyte, hệ nhị phân):** $1\text{ MiB} = 1{,}048{,}576\text{ bytes}$ (dùng cho cấp phát RAM, giới hạn byte thực tế như $6\text{ MiB} = 6{,}291{,}456\text{ bytes}$, $200\text{ MiB} = 209{,}715{,}200\text{ bytes}$). Lưu ý một số tài liệu hoặc thông báo của AWS sử dụng ký hiệu `MB` cho giá trị tính theo nhị phân; báo cáo sẽ ghi kèm số bytes thực tế để đối chiếu minh bạch.  
> * **Định dạng số:** Dấu phẩy `,` ngăn cách hàng nghìn (ví dụ: `10,485,760`), dấu chấm `.` cho phần thập phân (ví dụ: `19.234 s`) xuyên suốt toàn bộ báo cáo.

---

## 1. Mở đầu

### 1.1. Mục đích thực nghiệm
Trong quá trình thiết kế các giải pháp điện toán không máy chủ (Serverless), việc tiếp nhận và xuất dữ liệu tệp tin nhị phân (đặc biệt là bảng tính Excel `.xlsx`) luôn phải đối mặt với các giới hạn nghiêm ngặt về kích thước tải trọng (payload quotas) và thời gian thực thi (execution timeout). Dự án này được thiết lập nhằm:
* Xây dựng một môi trường Serverless chuẩn mực trên AWS phục vụ đo lường độc lập, hoàn toàn không sử dụng tầng lưu trữ trung gian S3, Database hay giao diện Frontend.
* Triển khai hệ thống gồm 5 hàm AWS Lambda chuyên biệt thực thi trên runtime Node.js 24 (`nodejs24.x`).
* Thiết lập 2 cổng giao tiếp độc lập: **Amazon API Gateway HTTP API** và **AWS Lambda Function URLs** (với 2 chế độ `BUFFERED` và `RESPONSE_STREAM`).
* Khảo sát thực nghiệm ranh giới tải lên (Upload Boundary) và cơ chế tải về (Response Streaming) đối với các file Excel có dung lượng từ nhỏ (vài chục KB) đến rất lớn (~23 MB).
* Phân tích và truy vết nguồn gốc từ chối của các mã lỗi `HTTP 413 Payload Too Large` thông qua hệ thống quan sát đa tầng (Observability: Access Logs, cURL Transport Traces, Lambda Handler Logs).

### 1.2. Trình tự và mối liên hệ giữa các giai đoạn
Quá trình thực nghiệm được tự động hóa qua 6 giai đoạn có tính kế thừa chặt chẽ:
1. **`01-iam.sh` (Cấp quyền tối thiểu):** Khởi tạo IAM Execution Role bảo đảm Lambda chỉ có quyền ghi log vào CloudWatch, tuân thủ nguyên tắc Least Privilege.
2. **`02-lambda.sh` (Triển khai tính toán):** Đóng gói và phát hành 5 Lambda Functions với các mức cấp phát bộ nhớ (128 MB – 1,024 MB) và thời gian chạy phù hợp.
3. **`03-apigateway.sh` (Thiết lập cổng API):** Cấu hình API Gateway HTTP API v2, tích hợp proxy với Lambda, mở Stage `dev` và kích hoạt hệ thống ghi nhật ký truy cập (Stage Access Logging).
4. **`04-function-url.sh` (Thiết lập điểm cuối trực tiếp):** Kích hoạt Function URLs cho các hàm tạo file và tải file ở cả hai chế độ `BUFFERED` và `RESPONSE_STREAM`.
5. **`05-test.sh` (Kiểm thử tích hợp & Bóc tách ranh giới):** Thực thi 21 kịch bản kiểm thử từ cơ bản đến nâng cao để kiểm tra tính toàn vẹn dữ liệu và phân tích ranh giới từ chối của từng lớp hạ tầng.
6. **`06-benchmark.sh` (Đo lường hiệu năng & Khảo sát giới hạn phần cứng):** Thực hiện các phép đo định lượng về độ trễ giữa hai kênh upload, co giãn vCPU theo Memory, thực nghiệm timeout 5 giây, và truyền dòng phản hồi đến ngưỡng ~200 MiB.

---

## 2. Chi tiết từng giai đoạn triển khai (Giai đoạn 01 – 04)

### Giai đoạn 01: Thiết lập IAM Execution Role (`infra/01-iam.sh`)

#### a. Mục tiêu
Mọi hàm AWS Lambda khi khởi chạy đều yêu cầu một danh tính IAM (Execution Role) để ủy quyền cho dịch vụ Lambda thay mặt người dùng thực hiện các thao tác hệ thống cơ bản. Mục tiêu của giai đoạn này là cung cấp một IAM Role duy nhất, áp dụng chính sách cấp quyền tối thiểu tuyệt đối (Least Privilege), phục vụ cho tất cả các Lambda functions trong dự án.

#### b. Nội dung triển khai
* Thiết lập một **Trust Policy** (chính sách tin cậy) cho phép thực thể dịch vụ `lambda.amazonaws.com` thực hiện hành động `sts:AssumeRole`.
* Tạo IAM Role có tên quy ước theo dự án: `${PROJECT}-execution-role`.
* Gắn duy nhất chính sách do AWS quản lý: `AWSLambdaBasicExecutionRole` (`arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`).
* Bổ sung cơ chế chờ (propagation delay) nhằm bảo đảm quyền IAM đã được đồng bộ toàn cầu trước khi bước sang giai đoạn triển khai hàm. Script được thiết kế bảo đảm tính **idempotent** (tự động bỏ qua nếu role đã tồn tại).

#### c. Thành phần được tạo và cấu hình
* **IAM Role:** `lambda-file-api-execution-role`.
* **Phạm vi quyền thực tế:** Role chỉ được phép tạo log groups, log streams và ghi sự kiện log vào CloudWatch (`logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`). Tuyệt đối không cấp quyền truy cập S3, DynamoDB hay các dịch vụ không liên quan.

#### d. Kết quả thực hiện
Role được tạo thành công, xác nhận thông qua lệnh `aws iam get-role`. Danh tính này sẵn sàng để gắn vào các hàm Lambda ở Giai đoạn 02.

---

### Giai đoạn 02: Triển khai các Lambda Functions (`infra/02-lambda.sh`)

#### a. Mục tiêu
Triển khai mã nguồn ứng dụng (đã được biên dịch từ TypeScript sang JavaScript và đóng gói kèm dependencies production trong thư mục `zips/`) lên AWS Lambda trên runtime hiện đại Node.js 24.

#### b. Nội dung triển khai
Thay vì xây dựng một hàm đơn khối (Monolithic Function) đảm nhận mọi tác vụ, dự án phân tách thành 5 hàm chuyên biệt theo nguyên lý đơn trách nhiệm (Single Responsibility Principle):
1. **Tách biệt mức tiêu thụ tài nguyên:** Các tác vụ nhẹ (health check, info) chỉ cần 128 MB RAM, trong khi tác vụ nặng (tạo bảng tính 50,000 dòng) cần 1,024 MB RAM. AWS Lambda phân bổ tài nguyên CPU theo cấu hình bộ nhớ. Theo tài liệu AWS, hàm Lambda được cấp khoảng một vCPU tại mức 1,769 MB bộ nhớ; khi tăng bộ nhớ, năng lực CPU được phân bổ cũng tăng theo.
2. **Cô lập rủi ro bộ nhớ:** Nếu hàm phân tích Excel gặp tệp quá lớn dẫn đến áp lực bộ nhớ (heap pressure), sự cố chỉ nằm trong container của hàm đó mà không gây ảnh hưởng đến tính sẵn sàng của các API giám sát.
3. **Cấu hình Invoke Mode chuyên biệt:** Hàm streaming đòi hỏi cơ chế xử lý luồng phản hồi riêng biệt (`awslambda.streamifyResponse`), không thể gộp chung với các hàm đồng bộ thông thường.

#### c. Thành phần được tạo và cấu hình (Cấu hình khởi tạo từ `02-lambda.sh`)

| Tên Function | Handler | RAM | Timeout (Ban đầu) | Vai trò kiến trúc |
| :--- | :--- | :---: | :---: | :--- |
| `lambda-file-api-health` | `handlers/health.handler` | 128 MB | 10s | Kiểm tra nhịp tim, trả về runtime Node.js v24 và metadata bộ nhớ |
| `lambda-file-api-info` | `handlers/info.handler` | 128 MB | 10s | Cung cấp tài liệu tra cứu các giới hạn dịch vụ do AWS quy định |
| `lambda-file-api-upload-excel` | `handlers/uploadExcel.handler` | 512 MB | 60s | Tiếp nhận file (binary/multipart), kiểm tra Memory Guard (5 MiB), parse XLSX |
| `lambda-file-api-generate-excel` | `handlers/generateExcel.handler` | 1,024 MB | 120s | Khởi tạo bảng tính Excel trong RAM và trả về phản hồi đồng bộ (BUFFERED) |
| `lambda-file-api-generate-excel-stream` | `handlers/generateExcelStream.handler` | 1,024 MB | 120s\* | Khởi tạo bảng tính/dòng dữ liệu giả lập và truyền dòng (RESPONSE_STREAM) |

*\*Tất cả 5 hàm đều sử dụng chung `lambda-file-api-execution-role` và chạy trên runtime `nodejs24.x`. Riêng `lambda-file-api-generate-excel-stream` có timeout mặc định trong script triển khai `02-lambda.sh` là `120s`; tuy nhiên, cấu hình AWS thực tế tại thời điểm chạy benchmark Run 3 là `300s` (do một lần chạy trước đó bị ngắt giữa chừng). Script `06-benchmark.sh` đã ghi nhận đúng cấu hình `300s` trước khi chạy và khôi phục lại đúng giá trị này sau khi hoàn thành.*

#### d. Kết quả thực hiện
Cả 5 hàm đều được khởi tạo và chuyển sang trạng thái `State: Active`, sẵn sàng tiếp nhận các sự kiện kích hoạt từ API Gateway hoặc Function URLs.

---

### Giai đoạn 03: Thiết lập API Gateway HTTP API (`infra/03-apigateway.sh`)

#### a. Mục tiêu
Xây dựng một API Gateway làm cửa ngõ định tuyến công khai chính cho hệ thống. Dự án lựa chọn **HTTP API (API Gateway v2)** thay vì REST API cổ điển vì HTTP API có độ trễ thấp hơn, chi phí thấp hơn đáng kể, hỗ trợ mặc định chuẩn Payload Format 2.0 và trần tải trọng yêu cầu ở tầng tiếp nhận của API Gateway là **10 MB**.

#### b. Nội dung triển khai
* Khởi tạo HTTP API với cấu hình CORS toàn diện (`AllowOrigins='*'`, hỗ trợ `GET, POST, OPTIONS`).
* Thiết lập 4 Integrations theo kiểu `AWS_PROXY` (Payload Format 2.0) kết nối tới các hàm Lambda tương ứng.
* Khai báo 4 Routes:
  - `GET /health` → `lambda-file-api-health`
  - `GET /info` → `lambda-file-api-info`
  - `POST /upload-excel` → `lambda-file-api-upload-excel`
  - `GET /generate-excel` → `lambda-file-api-generate-excel`
* Cấp quyền `lambda:InvokeFunction` cho dịch vụ API Gateway (`apigw.amazonaws.com` / `apigateway.amazonaws.com`) trên từng hàm với Statement ID có tính idempotent.
* **Cấu hình Access Logging có cấu trúc:** Tạo CloudWatch Log Group `/aws/apigateway/lambda-file-api-access-logs` (lưu trữ 7 ngày) và kích hoạt ghi nhật ký JSON cho Stage `dev` (bật `auto-deploy`).

Định dạng nhật ký truy cập được chuẩn hóa như sau:
```json
{
  "requestId": "$context.requestId",
  "extendedRequestId": "$context.extendedRequestId",
  "requestTime": "$context.requestTime",
  "httpMethod": "$context.httpMethod",
  "routeKey": "$context.routeKey",
  "status": "$context.status",
  "responseLength": "$context.responseLength",
  "integrationStatus": "$context.integrationStatus",
  "integrationLatency": "$context.integrationLatency",
  "integrationErrorMessage": "$context.integrationErrorMessage",
  "integrationError": "$context.integration.error",
  "integrationRequestId": "$context.integration.requestId"
}
```

#### c. Thành phần được tạo và cấu hình
* **API Gateway HTTP API:** Tên `lambda-file-api-http-api`.
* **Stage:** `dev` với điểm cuối cơ sở (Base URL): `https://<api-id>.execute-api.<region>.amazonaws.com/dev`.
* **Log Group:** `/aws/apigateway/lambda-file-api-access-logs`.

#### d. Kết quả thực hiện
Các route được kích hoạt hoàn chỉnh. API Gateway đóng vai trò trung gian: khi client gửi request nhị phân, API Gateway sẽ tự động mã hóa Base64 phần body và đóng gói vào event JSON chuyển tiếp đến Lambda.

---

### Giai đoạn 04: Thiết lập Lambda Function URLs (`infra/04-function-url.sh`)

#### a. Mục tiêu
Lambda Function URL cung cấp một endpoint HTTPS chuyên dụng trực tiếp tới một hàm Lambda cụ thể mà không cần qua tầng trung gian API Gateway. Mục tiêu cấu hình Function URL trong dự án này là:
1. **Kiểm tra cơ chế Response Streaming (200 MB / 200 MiB):** API Gateway áp dụng trần cứng phản hồi 10 MB và giới hạn timeout 29 giây. Function URL với chế độ `RESPONSE_STREAM` cho phép truyền luồng phản hồi lớn theo tài liệu AWS (tối đa 200 MB) và kéo dài thời gian chạy tới 15 phút.
2. **Khảo sát đối chứng tải lên (Comparative Upload Baseline):** Tạo đường dẫn tải lên trực tiếp tới `upload-excel` để đối chiếu với API Gateway, xem xét liệu việc bỏ qua tầng kiểm soát 10 MB của API Gateway có làm thay đổi trần tải lên hay không.

#### b. Nội dung triển khai
Cấu hình 3 Function URLs với quyền công khai (`AuthType NONE`) và cấp quyền `lambda:InvokeFunctionUrl`:
1. `lambda-file-api-generate-excel`: Chế độ `BUFFERED` (dùng để đối chứng với API Gateway trên cùng tải trọng sinh Excel).
2. `lambda-file-api-generate-excel-stream`: Chế độ `RESPONSE_STREAM` (phục vụ truyền dòng dữ liệu lớn).
3. `lambda-file-api-upload-excel`: Chế độ `BUFFERED` (phục vụ đối chứng ranh giới upload trực tiếp).

#### c. Thành phần được tạo và cấu hình

| Function Name | Invoke Mode | URL Output (Định dạng) | Mục đích thử nghiệm |
| :--- | :---: | :--- | :--- |
| `generate-excel` | `BUFFERED` | `https://<url-id>.lambda-url.<region>.on.aws/` | Đo lường phản hồi đồng bộ (trần 6 MiB) |
| `generate-excel-stream` | `RESPONSE_STREAM` | `https://<url-id>.lambda-url.<region>.on.aws/` | Truyền dòng tệp/synthetic chunk (giới hạn tài liệu 200 MB) |
| `upload-excel` | `BUFFERED` | `https://<url-id>.lambda-url.<region>.on.aws/` | Đối chứng upload file nhị phân trực tiếp |

#### d. Kết quả thực hiện & Lưu ý kỹ thuật quan trọng
* Cả 3 Function URLs hoạt động ổn định và sẵn sàng nhận diện yêu cầu qua giao thức HTTPS.
* **Lưu ý kỹ thuật:** Function URL sử dụng cấu trúc Payload Format 2.0. Khi tiếp nhận request nhị phân, Function URL **vẫn tiến hành Base64-encode request body** tương tự API Gateway. Ở chế độ `BUFFERED`, Function URL vẫn bị chi phối bởi giới hạn 6 MiB (`6,291,456 bytes`) của `RequestResponse` invocation. Do đó, Function URL **không tự động loại bỏ chi phí Base64** khi tải file lên.

---

## 3. Giai đoạn 05: Kiểm thử chức năng và Khảo sát Giới hạn Kiến trúc (`infra/05-test.sh`)

Giai đoạn kiểm thử bao gồm **21 kịch bản kiểm thử độc lập**, được chia thành 4 nhóm nghiệp vụ chính (5 kịch bản Nhóm 1 + 7 kịch bản Nhóm 2 + 4 kịch bản Nhóm 3 + 5 mốc kích thước Nhóm 4 = 21 kịch bản). Toàn bộ 21/21 kịch bản đều đạt trạng thái **PASS** (kết quả thực tế trả về khớp với kỳ vọng thiết kế kiến trúc).

---

### Nhóm 1: Kiểm tra chức năng cơ bản & Tính toàn vẹn dữ liệu

Nhóm kiểm thử này xác nhận các chức năng nền tảng và khả năng bóc tách tệp nhị phân trong phạm vi tải trọng an toàn:

* **CORE-1 (Health Check):** Gửi `GET /health` qua API Gateway. Nhận mã `HTTP 200`, `status: "ok"`, runtime Node.js `v24.22.3`, thời gian xử lý còn lại `9,947 ms` (ghi nhận tại Stage Access Log ngày 25/11: `integrationLatency: 398 ms`).
* **CORE-2 (Info & System Limits):** Gửi `GET /info`. Nhận mã `HTTP 200` kèm tài liệu mô tả các giới hạn phần cứng của AWS (`integrationLatency: 407 ms`).
* **CORE-3A (Upload Raw Binary – 100 dòng):** Tải file Excel nhỏ dạng nhị phân thô (`10,696 bytes`, `Content-Type: application/octet-stream`). Nhận mã `HTTP 200`, phân tích chính xác 100 dòng dữ liệu, 5 cột.
* **CORE-3B (Upload Multipart Form-Data – 100 dòng):** Tải file qua định dạng biểu mẫu `multipart/form-data`. Nhận mã `HTTP 200`, bộ bóc tách `multipartParser` trích xuất thành công nội dung Excel và phân tích chuẩn xác 100 dòng.
* **CORE-4 (Upload Medium Excel – 1,000 dòng, `45,982 bytes`):** Tải file quy mô trung bình. Nhận mã `HTTP 200`, Lambda phân tích thành công 1,000 dòng (`parseElapsedMs: 550 ms` trong log baseline 05-test).

---

### Nhóm 2: Khảo sát Ranh giới Tải lên (Upload Boundary Testing)

Đây là phần trọng tâm của thực nghiệm, khảo sát hành vi của hệ thống khi kích thước file tăng dần qua các mốc ranh giới của API Gateway (10 MB) và Lambda (6 MiB = `6,291,456 bytes`).

#### Bảng tổng hợp kết quả thực nghiệm Upload Boundary

| Mã Test | Tệp kiểm thử | Kích thước thô | Đường dẫn | HTTP Status | Kết quả | Diễn giải tầng xử lý / từ chối |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **CORE-5.1** | `excel-1mb.xlsx` | `1,051,388 B` (`1.003 MiB` / `1.051 MB`) | API Gateway | **200 OK** | PASS | Vượt qua hạ tầng, Handler phân tích 10,581 dòng |
| **CORE-5.2** | `excel-3mb.xlsx` | `3,127,840 B` (`2.983 MiB` / `3.128 MB`) | API Gateway | **200 OK** | PASS | Vượt qua hạ tầng, Handler phân tích 31,743 dòng |
| **CORE-5.3** | `excel-5mb.xlsx` | `5,355,055 B` (`5.107 MiB` / `5.355 MB`) | API Gateway | **413 Too Large** | PASS | Bị từ chối trong quá trình API GW gọi Lambda (vượt 6 MiB) |
| **CORE-5.4** | `excel-12mb.xlsx` | `12,772,047 B` (`12.180 MiB` / `12.772 MB`) | API Gateway | **413 Too Large** | PASS | Bị từ chối tại API Gateway trước khi vào Stage Integration (>10 MB) |
| **CORE-5.5** | `Online Retail.xlsx` | `~23 MB` | API Gateway | **413 Too Large** | PASS | Bị từ chối tại API Gateway trước khi vào Stage Integration (>10 MB) |
| **CORE-5.6** | `invalid-corrupted.xlsx` | `107 bytes` | API Gateway | **422 Unprocessable** | PASS | Vượt qua hạ tầng, bị chặn bởi **Application Validation** |
| **CORE-5.7** | `excel-5mb.xlsx` | `5,355,055 B` (`5.107 MiB` / `5.355 MB`) | Function URL | **413 Too Large** | PASS | Bị từ chối tại giới hạn `RequestResponse` 6 MiB của Lambda |

---

#### Phân tích chuyên sâu: Hiện tượng Base64 Inflation và Ranh giới Upload thực tế

Một câu hỏi kiến trúc cốt lõi được đặt ra: **Tại sao một file Excel `5,355,055 bytes` (`5.107 MiB` / `5.355 MB`) hợp lệ, nhỏ hơn giới hạn 10 MB của API Gateway, vẫn bị từ chối với mã HTTP 413?**

Nguyên nhân xuất phát từ sự chuyển đổi giữa giao thức HTTP nhị phân và mô hình sự kiện JSON của AWS Lambda:
1. **Giới hạn gọi đồng bộ của Lambda:** AWS Lambda quy định giới hạn cứng cho tải trọng sự kiện gọi đồng bộ (`RequestResponse` invocation type) là **6 MiB (`6,291,456 bytes`)**. Giới hạn này áp dụng cho toàn bộ nội dung của JSON event chuyển vào hàm.
2. **Hiện tượng Base64 Inflation:** Khi client gửi một file nhị phân qua API Gateway v2, để truyền qua JSON, API Gateway mã hóa nội dung nhị phân thành chuỗi văn bản Base64 (`isBase64Encoded: true`). Thuật toán Base64 mã hóa mỗi nhóm 3 bytes thành 4 ký tự ASCII (có đệm `=` khi chiều dài không chia hết cho 3) theo công thức chính xác:
   $$\text{Base64 Bytes} = 4 \times \left\lceil \frac{\text{Raw Bytes}}{3} \right\rceil$$
   Làm dung lượng tăng thêm xấp xỉ **$\approx 33.3\%$**.
3. **Phép tính chính xác trên file `excel-5mb.xlsx` (`5,355,055 bytes`):**
   ```text
   Kích thước nhị phân thô:  5,355,055 bytes
   Kích thước sau Base64:    7,140,076 bytes   [= 4 × ceil(5,355,055 / 3)]
   Phần metadata còn lại:        1,014 bytes   (headers, requestContext, cookies...)
   -----------------------------------------
   Tổng payload sự kiện:     7,141,090 bytes
   ```
   Rõ ràng: $7,141,090\text{ bytes} > 6,291,456\text{ bytes}$ (vượt giới hạn 6 MiB tới `849,634 bytes`).
4. **Trần upload thực tế (Effective Raw Upload Ceiling):**
   Để toàn bộ JSON event không vượt quá `6,291,456 bytes`, kích thước tệp thô tối đa lý thuyết vào khoảng:
   $$\text{Max Raw File Size} \approx \frac{6,291,456 - 1,500}{4/3} \approx 4,717,467\text{ bytes} \quad (\approx \mathbf{4.50\text{ MiB}} \approx 4.72\text{ MB})$$
   Do đó, file `1.003 MiB` (CORE-5.1) và `2.983 MiB` (CORE-5.2) tải lên thành công, trong khi file `5.107 MiB` (CORE-5.3) chắc chắn thất bại.

---

#### Bóc tách nguồn gốc từ chối bằng CloudWatch Access Logs & cURL Telemetry

Đứng từ phía client, cả CORE-5.3 (`5.107 MiB`) và CORE-5.4 (`12.180 MiB`) đều trả về cùng mã lỗi `HTTP 413` và cùng chuỗi JSON generic: `{"message":"Request Entity Too Large"}`. Bằng cách kết hợp **CloudWatch Stage Access Logs** và **dấu vết truyền tải của cURL**, dự án đã phân tách được vị trí từ chối của hai phản hồi này:

```text
[Bản đồ Truy vết Nguồn gốc Từ chối]

Client (5.107 MiB Raw)  ──► [API GW Request Ingestion] ──(Pass)──► [Stage dev] ──(Base64 = 7.14 MB)──► [Lambda Invoke] ──(REJECT > 6 MiB)
                                                                                                             │
                                                                Access Log ghi nhận: integrationStatus=413 ◄─┘

Client (12.180 MiB Raw) ──► [API GW Request Ingestion] ──(REJECT Early: > 10 MB)
                                │
                                └── Không vào Stage dev, ngắt gửi sớm, trả HTTP 413 kèm apigw-requestid
```

##### 1. Trường hợp File `excel-5mb.xlsx` (`5,355,055 bytes`) qua API Gateway (`CORE-5.3`):
Dòng Access Log thực tế được trích xuất từ CloudWatch tại thời điểm kiểm thử:
```json
{
  "requestTime": "25/Nov/2026:02:48:38 +0000",
  "httpMethod": "POST",
  "routeKey": "POST /upload-excel",
  "status": "413",
  "responseLength": "38",
  "integrationStatus": "413",
  "integrationLatency": "42",
  "integrationErrorMessage": "-",
  "integrationRequestId": "-"
}
```
* **Phân tích bằng chứng:** `integrationLatency: "42"` cho thấy request đã đi qua Stage để gọi tích hợp Lambda trong 42 ms, và `integrationStatus: "413"` kèm `integrationRequestId: "-"` (container không được khởi tạo) xuất hiện trong bản ghi integration. **Đây là bằng chứng mạnh cho thấy lỗi 413 phát sinh trong quá trình API Gateway gọi Lambda, thay vì do logic kiểm tra file trong handler.**
* **Củng cố bởi đối chứng Function URL (`CORE-5.7`):** Khi gửi cùng file này trực tiếp qua Function URL (không qua API Gateway), kết quả trả về thông điệp trực tiếp từ dịch vụ Lambda:
  ```json
  {"Message":"7141090 byte payload is too large for the RequestResponse invocation type (limit 6291456 bytes)"}
  ```
  Con số `7,141,090 bytes` khớp chính xác với phép tính Base64 ở trên (`7,140,076 + 1,014`), củng cố chắc chắn kết luận lỗi 413 ở mốc 5.107 MiB xuất phát từ giới hạn `RequestResponse` 6 MiB của Lambda.

##### 2. Trường hợp File `excel-12mb.xlsx` (`12,772,047 bytes`) qua API Gateway (`CORE-5.4`):
Khi kiểm tra CloudWatch Access Logs của Stage `dev`, request này **không xuất hiện trong danh sách log**. Dấu vết cURL chi tiết (`curl -v`) ghi nhận:
```text
> POST /dev/upload-excel HTTP/2
> Host: re09mfu3ui.execute-api.ap-southeast-2.amazonaws.com
> Content-Type: application/octet-stream
> Content-Length: 12772047
> 
* TLSv1.3 (IN), TLS handshake, Newsession Ticket (4):
< HTTP/2 413 
< date: Wed, 25 Nov 2026 03:15:02 GMT
< content-length: 38
< apigw-requestid: HYHcljUQSwMEJQQ=
* HTTP error before end of send, stop sending
```
* **Phân tích bằng chứng:** Header `< apigw-requestid: HYHcljUQSwMEJQQ=` là định danh trả về từ API Gateway. Dòng `* HTTP error before end of send, stop sending` cho thấy API Gateway trả `HTTP 413` trước khi client kịp truyền xong body. Kết hợp với việc `Content-Length` (`12,772,047 bytes` $\approx 12.18\text{ MiB} / 12.77\text{ MB}$) vượt ngưỡng 10 MB và không có bản ghi trong Stage Access Logs:
  **Các dấu vết cURL và CloudWatch cho thấy request nhiều khả năng bị từ chối tại tầng tiếp nhận request của API Gateway, trước khi đi vào giai đoạn Stage Integration. Thực nghiệm xác nhận request không được chuyển tiếp thành công tới Lambda, nhưng không đủ bằng chứng từ phía client để xác định chính xác thành phần nội bộ nào của API Gateway thực hiện việc từ chối.**

##### 3. Trường hợp File không hợp lệ (`CORE-5.6`):
```json
{
  "status": "422",
  "integrationStatus": "200",
  "integrationLatency": "32",
  "integrationRequestId": "6c03b253-45e1-4581-8fde-351b9499f4c6"
}
```
* **Bằng chứng:** `integrationStatus: "200"` và `integrationRequestId` có UUID thực tế xác nhận request đã kích hoạt thành công container Lambda. Mã `status: "422"` do logic TypeScript trong handler kiểm tra không thấy chữ ký ZIP/PK nên trả về `HTTP 422 Unprocessable Entity`.

---

### Nhóm 3: Kiểm tra chức năng Sinh file Excel (Generate Excel)

Nhóm thử nghiệm này kiểm tra khả năng tạo bảng tính Excel trong bộ nhớ và truyền về client qua các phương thức khác nhau:

* **CORE-6 (Generate 1,000 dòng qua API Gateway):** Trả về file Excel hợp lệ dung lượng `57,498 bytes` (~56.15 KiB / 57.50 KB).
* **CORE-7 (Generate 50,000 dòng qua API Gateway):** Trả về file Excel hợp lệ dung lượng `2,585,492 bytes` (`~2.466 MiB` / `~2.585 MB`) với 50,000 dòng dữ liệu thực tế.
* **EXP-1 (Generate 50,000 dòng qua Function URL BUFFERED):** Trả về file Excel hợp lệ dung lượng `2,584,524 bytes` (`~2.465 MiB` / `~2.585 MB`).
* **EXP-2A (Generate 50,000 dòng qua Function URL RESPONSE_STREAM):** Trả về file Excel hợp lệ dung lượng `2,584,436 bytes` (`~2.465 MiB` / `~2.584 MB`).

**Nhận xét kỹ thuật:** Bảng tính Excel (.xlsx) là một gói nén ZIP (OpenXML). Dữ liệu văn bản và số của 50,000 dòng sau khi nén chỉ chiếm `~2.466 MiB` (`~2.585 MB`), nằm hoàn toàn dưới giới hạn 6 MiB của chế độ BUFFERED (và dưới giới hạn 10 MB của API Gateway), nên tải về thành công ở cả 3 phương thức.

---

### Nhóm 4: Kiểm tra Truyền dòng dữ liệu Phản hồi (Response Streaming – EXP-2B)

Thực nghiệm đo lường từ lần chạy hoàn tất 21/21 của `infra/05-test.sh` trên hàm `lambda-file-api-generate-excel-stream` ở chế độ **Synthetic Chunked Streaming** (chunk size = 64 KiB = `65,536 bytes`):

| Kích thước mục tiêu | Dung lượng thực nhận (Bytes) | Thời gian truyền | Thông lượng đo được\* | Trạng thái |
| :---: | :---: | :---: | :---: | :---: |
| **1 MiB** | `1,048,576` | **1,896 ms** (1.90 s) | 0.53 MiB/s | **PASS** |
| **5 MiB** | `5,242,880` | **4,180 ms** (4.18 s) | 1.20 MiB/s | **PASS** |
| **10 MiB** | `10,485,760` | **33,741 ms** (33.74 s) | 0.30 MiB/s | **PASS** |
| **25 MiB** | `26,214,400` | **14,091 ms** (14.09 s) | 1.77 MiB/s | **PASS** |
| **50 MiB** | `52,428,800` | **17,941 ms** (17.94 s) | 2.79 MiB/s | **PASS** |

*\*Ghi chú: Script `05-test.sh` tính toán thông lượng bằng phép chia nhị phân `(bytes / 1024 / 1024) / seconds` (tức MiB/s, trên console hiển thị nhãn `MB/s`). Thời gian `1,896 ms` đến `33,741 ms` được xác nhận trực tiếp từ log thực thi 21/21 của `infra/05-test.sh`.*

**Ý nghĩa kiến trúc:**
1. **Phá vỡ giới hạn đồng bộ:** Thử nghiệm thành công với các gói 10 MiB, 25 MiB và 50 MiB cho thấy Function URL `RESPONSE_STREAM` vượt qua trần 6 MiB (Lambda) và 10 MB (API Gateway) ở chiều tải về (response).
2. **Quy tắc điều tiết băng thông của AWS:** Theo tài liệu chính thức của AWS Lambda, 6 MB đầu tiên của response stream không bị giới hạn tốc độ; phần còn lại bị điều tiết băng thông ở mức 2 MBps (16 Mbps). Thông lượng đo thực tế ở các gói 25 MiB và 50 MiB (1.77 – 2.79 MiB/s) phù hợp với hành vi này.
3. **Phân định chiều xử lý:** **Response Streaming chỉ áp dụng cho chiều xuất dữ liệu từ Lambda về Client**, không mở rộng giới hạn tải lên (Upload Request Payload).

---

## 4. Giai đoạn 06: Đo lường Hiệu năng & Khảo sát Cấu hình Chuyên sâu (`infra/06-benchmark.sh`)

Giai đoạn 06 tập trung vào các phép đo định lượng về độ trễ, khả năng co giãn CPU theo Memory, xác minh lỗi timeout và khảo sát ngưỡng truyền dòng gần 200 MiB. Toàn bộ số liệu dưới đây được ghi nhận trực tiếp từ lần thực thi chuẩn hóa cuối cùng (Run 3), với cơ chế đối chiếu Request ID chính xác, tách biệt header/body và kiểm định toàn vẹn mẫu byte:

---

### 4.1. TEST A: So sánh Kênh Tải lên (API Gateway vs Function URL) với Tệp Nặng

Thực nghiệm sử dụng tệp `xxlarge-100000rows.xlsx` chứa **100,000 dòng dữ liệu thực tế** (5 cột), dung lượng thô **3,916,927 bytes (`~3.735 MiB` / `~3.917 MB`, ~5.22 MB ở dạng Base64 event)**. Thực hiện đo lặp lại 2 lần liên tiếp cho mỗi kênh:

| Lượt chạy (Run) | Kênh 1: API Gateway (`POST /upload-excel`) | Kênh 2: Lambda Function URL (`POST /`) | Chênh lệch thời gian Client |
| :---: | :---: | :---: | :---: |
| **Run 1** | **26.17 s** (Parse: **19.234 s** [`19,234 ms`], ReqID: `HYUjTjlhSwMEJQA=`) | **19.94 s** (Parse: **16.624 s** [`16,624 ms`], ReqID: `0050f988-...`) | Function URL nhanh hơn **6.23 s** |
| **Run 2** | **24.88 s** (Parse: **17.658 s** [`17,658 ms`], ReqID: `HYUnoj21ywMEKhg=`) | **19.56 s** (Parse: **16.433 s** [`16,433 ms`], ReqID: `f77f32e4-...`) | Function URL nhanh hơn **5.32 s** |
| **Trung bình (Mean)** | **25.53 s** (Parse TB: ~18.45 s) | **19.75 s** (Parse TB: ~16.53 s) | **Function URL nhanh hơn 5.78 s (+22.6%)** |

**Làm rõ phương pháp luận & Phân định kết quả:**
1. **Bản chất mã hóa Base64:** Cả API Gateway HTTP API v2 và Lambda Function URL đều sử dụng chuẩn Payload Format 2.0 và **đều nhận dữ liệu nhị phân dưới dạng Base64-encoded** (`isBase64Encoded: true`). Function URL **không loại bỏ chi phí Base64**.
2. **Phạm vi đo lường:** Script chỉ đo tổng thời gian ở phía client (`Total time`) và thời gian parse nội bộ Lambda (`parseElapsedMs`); không bóc tách riêng lẻ thời gian phân giải DNS, bắt tay TLS hay định tuyến nội bộ.
3. **Phân tích kết quả:** Trong hai lượt đo, Function URL có thời gian phản hồi phía client thấp hơn API Gateway trung bình 5.78 giây (22.6%). Kết quả cho thấy sự khác biệt về tổng thời gian phản hồi giữa hai phương thức truy cập trong điều kiện thực nghiệm này. Tuy nhiên, do số lượt đo còn hạn chế và chưa bóc tách latency từng tầng, chưa thể quy toàn bộ chênh lệch cho riêng overhead của API Gateway.

---

### 4.2. TEST B: Khảo sát Tương quan Memory & vCPU Scaling (128 MB vs 512 MB vs 1,024 MB)

Khối lượng công việc cố định: Sinh bảng tính Excel **10,000 dòng** (`GET /generate-excel?rows=10000`). Mọi dòng `REPORT` đều được đối chiếu 1-1 chính xác theo `Lambda Request ID` trích xuất từ header `X-Lambda-Request-Id`:

| Cấu hình RAM | Client Duration | Lambda Duration | Billed Duration | Max Memory Used | Init Duration | Request ID đối chiếu | Đánh giá |
| :---: | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **128 MB** | **30.74 s** | **26,257.16 ms** | 27,020 ms | **127 MB** | 761.98 ms | `c3aac58f-2e7d-411c-...` | **PASS** (Dùng 127/128 MB) |
| **512 MB** | **7.42 s** | **5,446.15 ms** | 6,189 ms | **220 MB** | 742.27 ms | `fe1266ba-7936-490e-...` | **PASS** (Nhanh hơn **4.82×**) |
| **1,024 MB** | **6.44 s** | **2,616.03 ms** | 3,361 ms | **265 MB** | 744.53 ms | `81b185a8-5967-4880-...` | **PASS** (Nhanh hơn **10.04×**) |

#### Phân tích mức tiêu thụ tài nguyên tính toán (GB-seconds)
1. **vCPU co giãn theo RAM:** Khi nâng RAM từ 128 MB lên 512 MB, `Lambda Duration` giảm từ **26.26 s xuống 5.45 s** (nhanh gấp **4.82 lần**). Nâng tiếp lên 1,024 MB, thời gian xử lý giảm còn **2.62 s** (nhanh gấp **10.04 lần** so với 128 MB).
2. **Tiêu thụ bộ nhớ thực tế (`Max Memory Used`):** Ở mức 128 MB, tiến trình Node.js đạt **127 MB trên giới hạn 128 MB** (gần chạm ngưỡng bộ nhớ cấu hình). Ở mức 512 MB và 1,024 MB, mức sử dụng tối đa đo được là 220 MB và 265 MB.
3. **So sánh mức tiêu thụ tính toán (`Billed Duration × GB`):**
   * **128 MB ($0.125\text{ GB}$):** $27.020\text{ s} \times 0.125\text{ GB} = \mathbf{3.3775\text{ GB-seconds}}$
   * **512 MB ($0.500\text{ GB}$):** $6.189\text{ s} \times 0.500\text{ GB} = \mathbf{3.0945\text{ GB-seconds}}$
   * **1,024 MB ($1.000\text{ GB}$):** $3.361\text{ s} \times 1.000\text{ GB} = \mathbf{3.3610\text{ GB-seconds}}$

> **Lưu ý về phạm vi phép tính:** Phép tính trên chỉ xét mức tiêu thụ bộ nhớ nhân với thời gian tính phí của Lambda (GB-seconds), chưa bao gồm request charges và các chi phí dịch vụ liên quan (API Gateway, CloudWatch Logs...). Kết quả cho thấy cấu hình **512 MB** có mức tiêu thụ GB-seconds thấp nhất (`3.0945 GB-seconds`) trong ba cấu hình được thử nghiệm, trong khi cấu hình **1,024 MB** đạt tốc độ xử lý nhanh gấp **10.04 lần** mức 128 MB với mức tiêu thụ GB-seconds gần tương đương (`3.3610` so với `3.3775`).

---

### 4.3. TEST C: Xác nhận Lambda Timeout qua API Gateway Access Logs và đối chiếu CloudWatch

* **Cấu hình:** Hạ timeout của `generate-excel` xuống **5 giây**; gửi request với tham số `?rows=100&delay=10`.
* **Dữ liệu thu thập theo từng tầng:**
  - **Tầng Client:** Nhận `HTTP 500 Internal Server Error` sau **6.270 giây** (`API GW Request ID: HYU-Oh5iywMEPKA=`).
  - **Tầng API Gateway Access Logs (`/aws/apigateway/lambda-file-api-access-logs`):** Đã trích xuất thành công bản ghi của `HYU-Oh5iywMEPKA=`:
    * `API GW Integration Request ID`: `1e887eb0-fb94-4d53-8573-3f01cad379e3`
    * `API GW Integration Status`: `200`
    * `Integration Error`: `"The Lambda function returned the following error: RequestId: 1e887eb0-fb94-4d53-8573-3f01cad379e3 Error: Task timed out after 5.00 seconds. Check your Lambda function code and try again."`
  - **Tầng Lambda CloudWatch Logs (`/aws/lambda/lambda-file-api-generate-excel`):** Bản ghi tương ứng chưa được truy xuất thành công trong cửa sổ polling của Step C2.
* **Kết luận phân định rõ ràng:**
  Thực nghiệm **xác nhận Lambda bị timeout sau 5 giây** thông qua thông điệp Integration Error trong API Gateway Access Log (`RequestId: 1e887eb0-fb94-4d53-8573-3f01cad379e3 Error: Task timed out after 5.00 seconds`). Tuy nhiên, bản ghi Lambda CloudWatch Logs tương ứng chưa được truy xuất thành công trong thời gian chạy script, do đó **chưa hoàn tất đối chiếu trực tiếp giữa hai log group** (script ghi nhận trạng thái `[INCONCLUSIVE]` cho bước đối chiếu Log Group Lambda).

---

### 4.4. TEST D: Khảo sát True Response Streaming & Ngưỡng Giới hạn Phản hồi ~200 MiB

Tất cả các gói kiểm thử đều tách riêng hoàn toàn HTTP Headers (`-D`) và Response Body (`-o`), kèm thuật toán Python đối chiếu từng byte với cấu trúc `chunkBuffer` 64 KiB của generator:

| Gói dữ liệu mục tiêu | Header Bytes (Tách riêng) | Body Bytes thực nhận | Body (MiB) | TTFB | Tổng thời gian | Thông lượng\* | Kiểm tra thành phần (`HTTP` / `cURL` / `Size` / `Content`) | Trạng thái |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **10 MiB** (`10,485,760 B`) | 508 B | **10,485,760 B** | 10.0000 | 1.54 s | 4.59 s | 2.18 MiB/s | YES / YES / YES / YES | **PASS - COMPLETE** |
| **50 MiB** (`52,428,800 B`) | 508 B | **52,428,800 B** | 50.0000 | 0.45 s | 7.69 s | 6.50 MiB/s | YES / YES / YES / YES | **PASS - COMPLETE** |
| **100 MiB** (`104,857,600 B`) | 510 B | **104,857,600 B** | 100.0000 | 0.45 s | 21.88 s | 4.57 MiB/s | YES / YES / YES / YES | **PASS - COMPLETE** |
| **190 MiB** (`199,229,440 B`) | 510 B | **199,229,440 B** | 190.0000 | 0.45 s | 63.58 s | 2.99 MiB/s | YES / YES / YES / YES | **PASS - COMPLETE** |
| **205 MiB** (`214,958,080 B`) | 510 B | **209,714,917 B** | 199.9997 | 0.56 s | 79.99 s | 2.50 MiB/s | YES / YES / NO / YES | **PASS - QUOTA LIMIT OBSERVED** |

*\*Thông lượng hiển thị theo giá trị `MiB/s` (tính từ `(Body_Bytes / 1,048,576) / Total_Time`, trên console script hiển thị nhãn `MB/s`).*

#### Phân tích Chuyên sâu Mốc 10–205 MiB:
1. **Xác nhận toàn vẹn 4 mốc 10–190 MiB:** Cả 4 gói đều đạt **4/4 tiêu chí kiểm định** (`HTTP 200`, `cURL exit 0`, khớp 100% số bytes mục tiêu, và khớp 100% chuỗi byte đầu/đuôi của bộ sinh 64 KiB). Vì bản ghi 68 bytes không chia hết 65,536 bytes ($65,536 \pmod{68} = 52$), phần đuôi của mọi gói chuẩn kết thúc tại ký tự thứ 52 (`...,Benchmark,100,9`), hoàn toàn phù hợp với thiết kế của generator.
2. **Quan sát tại mốc 205 MiB:**
   * Dung lượng mục tiêu yêu cầu: **214,958,080 bytes** (`205.0000 MiB`).
   * Dung lượng body thực nhận (tách riêng với 510 bytes header): **209,714,917 bytes** (`199.9997 MiB`), thấp hơn mốc `200 MiB` (`209,715,200 bytes`) là **283 bytes**.
   * Phần đuôi tệp khớp chính xác mẫu byte generator cho tới điểm cắt giữa dòng (`...99.00,OK\n1,2024-01-01,Synthetic_Stream_Record,Benc`).
   * **Kết luận thận trọng:** Kết quả cho thấy luồng phản hồi bị cắt tại khoảng 200 MiB, phù hợp với giới hạn phản hồi 200 MB được AWS công bố. Tuy nhiên, thực nghiệm **chưa xác định được chính xác nguyên nhân của độ lệch 283 bytes** so với mốc 200 MiB danh nghĩa (và không quy kết 283 bytes này cho HTTP headers, vốn đã được tách riêng là 510 bytes).

---

## 5. Tổng kết Toàn diện Kết quả Dự án

Qua 6 giai đoạn thực hiện liên hoàn từ thiết lập hạ tầng đến đo lường hiệu năng chuyên sâu, dự án đã xác lập các kết luận thực nghiệm dựa trên bằng chứng đo đạc thực tế:

1. **Hạ tầng tự động hóa hoàn chỉnh & An toàn:** Toàn bộ vòng đời từ IAM Role, 5 Lambda Functions, API Gateway HTTP API v2 đến Function URLs (BUFFERED & RESPONSE_STREAM) được tự động hóa hoàn toàn kèm cơ chế `trap cleanup` khôi phục cấu hình gốc.
2. **Độ tin cậy của bộ kiểm thử:** 
   * Giai đoạn 05: Đạt **21/21 tests PASS** về ranh giới tải lên và tính toàn vẹn dữ liệu.
   * Giai đoạn 06: Hoàn tất 4 nhóm benchmark với đối chiếu Request ID chính xác và số liệu thực nghiệm minh bạch.
3. **Ranh giới tải lên (Upload Boundary):**
   * Tải file nhị phân đồng bộ qua API Gateway/Lambda bị khống chế ở trần hiệu dụng **~4.50 MiB raw** (`~4.72 MB`) do chi phí Base64 inflation (+33.3%, làm payload vượt trần 6 MiB = `6,291,456 bytes`).
   * Kênh Function URL rút ngắn trung bình **22.6%** thời gian client chờ đợi (`19.75 s` vs `25.53 s`) so với API Gateway trên cùng tệp 100,000 dòng (`3,916,927 bytes` = `3.735 MiB` / `3.917 MB`), dù cả hai kênh đều dùng Base64 encoding.
4. **Quy luật cấp phát tài nguyên (vCPU, Memory & GB-seconds):**
   * Tăng RAM từ 128 MB lên 1,024 MB giúp rút ngắn thời gian thực thi Lambda tới **10.04 lần** (`26.26 s` xuống `2.62 s`).
   * Xét riêng tài nguyên tính toán theo `GB-seconds` (chưa gồm request charges và phí dịch vụ khác), cấu hình **512 MB** có mức tiêu thụ thấp nhất (`3.0945 GB-s`), trong khi **1,024 MB** (`3.3610 GB-s`) đạt tốc độ cao nhất với mức tiêu thụ GB-seconds gần tương đương mức 128 MB (`3.3775 GB-s`).
5. **Giải pháp Response Streaming cho dữ liệu lớn:**
   * Cơ chế `RESPONSE_STREAM` vượt qua trần 6 MiB (Lambda) và 10 MB (API Gateway), truyền tải hoàn chỉnh tới **190 MiB** (`199,229,440 bytes`) với TTFB $< 0.6\text{ s}$.
   * Tại mốc 205 MiB, luồng dữ liệu bị cắt tại **209,714,917 bytes** (`199.9997 MiB`, lệch 283 bytes dưới mốc 200 MiB), phù hợp với giới hạn phản hồi 200 MB được AWS công bố (dù nguyên nhân độ lệch 283 bytes chưa được xác định cụ thể).

---

## 6. Phạm vi Hoàn thành Dự án

* [x] **Giai đoạn 01 (`01-iam.sh`):** Khởi tạo Execution Role và kiểm soát quyền CloudWatch Logs tối thiểu.
* [x] **Giai đoạn 02 (`02-lambda.sh`):** Đóng gói và triển khai 5 Lambda Functions trên Node.js 24.
* [x] **Giai đoạn 03 (`03-apigateway.sh`):** Thiết lập HTTP API, ánh xạ routes và cấu hình Structured JSON Access Logging.
* [x] **Giai đoạn 04 (`04-function-url.sh`):** Thiết lập Function URLs chế độ BUFFERED và RESPONSE_STREAM.
* [x] **Giai đoạn 05 (`05-test.sh`):** Thực thi 21 kịch bản kiểm thử biên, phân tích Access Logs và xác nhận ranh giới hạ tầng.
* [x] **Giai đoạn 06 (`06-benchmark.sh`):** Hoàn tất chuẩn hóa đo lường hiệu năng Upload (100k rows), Memory Scaling (128/512/1,024 MB kèm CloudWatch REPORT), **Timeout Verification (API Gateway Access Log; Lambda CloudWatch Log chưa đối chiếu trực tiếp)**, và Response Streaming (10–205 MiB).
