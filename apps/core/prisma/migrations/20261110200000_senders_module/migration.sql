-- CreateTable
CREATE TABLE "sender_accounts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "ownership_type" TEXT NOT NULL DEFAULT 'CUSTOMER_CONNECTED',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "daily_quota" INTEGER NOT NULL DEFAULT 50,
    "sent_today_count" INTEGER NOT NULL DEFAULT 0,
    "session_encrypted" TEXT,
    "name" TEXT,
    "cooldown_until" TIMESTAMP(3),
    "cooldown_reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sender_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sender_accounts_tenant_id_id_key" ON "sender_accounts"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sender_accounts_tenant_id_idx" ON "sender_accounts"("tenant_id");

-- CreateIndex
CREATE INDEX "sender_accounts_tenant_id_platform_idx" ON "sender_accounts"("tenant_id", "platform");

-- CreateIndex
CREATE INDEX "sender_accounts_tenant_id_status_idx" ON "sender_accounts"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "sender_accounts" ADD CONSTRAINT "sender_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable Row-Level Security (RLS) and FORCE RLS (Defense-in-Depth per TASK-0023 architecture)
ALTER TABLE "sender_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sender_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_policy" ON "sender_accounts"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));
