---
doc_id: DOC-ARCH-CONTEXT
owner_domain: architecture
status: draft
version: 0.1.0
---

# زمینه و مرز کلان سیستم

```mermaid
flowchart LR
    Customer["کاربر شرکت مشتری"] --> Web["پنل فارسی Next.js"]
    Admin["سوپرادمین خدمتگزاران تک"] --> Web
    Web --> Core["هسته NestJS"]
    Core --> DB["PostgreSQL؛ مرجع قطعی"]
    Core --> Queue["RabbitMQ؛ کارهای ارسال"]
    Core --> Cache["Redis؛ داده موقت"]
    Core --> Storage["فضای فایل خصوصی"]
    Queue --> Telegram["Connector تلگرام؛ PHP/MadelineProto"]
    Queue --> Bale["Connector رسمی بله"]
    Telegram --> TGExternal["Telegram API"]
    Bale --> BaleExternal["Bale Safir/Bot API"]
    Telegram --> Core
    Bale --> Core
    Core --> Realtime["WebSocket Inbox"]
    Realtime --> Web
    Core --> Monitor["لاگ، سنجه و هشدار"]
```

## مرزهای غیرقابل عبور

- Connectorها فقط قرارداد پیام را اجرا می‌کنند و مالک منطق مالی یا مجوز نیستند.
- پنل مستقیماً به Connector یا دیتابیس متصل نمی‌شود.
- هر عملیات تجاری دارای `tenant_id` اجباری است.
- رویداد زنده جای ثبت قطعی در PostgreSQL را نمی‌گیرد.
- خرابی یک کانال نباید پنل یا کانال دیگر را متوقف کند.

