---
doc_id: DOC-ARCH-STACK
owner_domain: architecture
status: proposed
version: 0.1.0
---

# فناوری پیشنهادی

| بخش | انتخاب |
|---|---|
| پنل وب | Next.js + TypeScript |
| API اصلی | NestJS + TypeScript |
| ساختار هسته | Modular Monolith |
| اتصال تلگرام | PHP + MadelineProto در سرویس مستقل |
| اتصال بله | سرویس مستقل با API رسمی |
| داده اصلی | PostgreSQL |
| صف ارسال | RabbitMQ |
| کش و قفل کوتاه | Redis |
| Inbox زنده | NestJS WebSocket |
| فایل‌ها | S3-compatible object storage |
| API عمومی | REST + OpenAPI |
| استقرار اولیه | Docker Compose |
| تست UI | Playwright |
| خطا | Sentry |
| سنجه/نمودار/لاگ | Prometheus + Grafana + Loki |
| رهگیری | OpenTelemetry |

## قوانین

- PostgreSQL مرجع قطعی داده تجاری است.
- Redis و RabbitMQ جای دیتابیس مالی نیستند.
- Next.js منطق صف، مالی یا Connector را اجرا نمی‌کند.
- MadelineProto فقط داخل Connector تلگرام قرار دارد.
- افزودن Microservice جدید نیازمند Decision مستقل است.
- نسخه‌های اصلی Dependencyها Pin می‌شوند؛ استفاده از `latest` ممنوع است.

