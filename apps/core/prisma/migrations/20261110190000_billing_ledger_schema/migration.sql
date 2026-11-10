-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "credit_limit" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "entry_type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "purpose" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_reservations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "settled_amount" BIGINT NOT NULL DEFAULT 0,
    "released_amount" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "purpose" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "release_reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenant_id_id_key" ON "accounts"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "accounts_tenant_id_idx" ON "accounts"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_tenant_id_id_key" ON "ledger_entries"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_tenant_id_account_id_sequence_key" ON "ledger_entries"("tenant_id", "account_id", "sequence");

-- CreateIndex
CREATE INDEX "ledger_entries_tenant_id_idx" ON "ledger_entries"("tenant_id");

-- CreateIndex
CREATE INDEX "ledger_entries_tenant_id_account_id_idx" ON "ledger_entries"("tenant_id", "account_id");

-- CreateIndex
CREATE INDEX "ledger_entries_reference_id_idx" ON "ledger_entries"("reference_id");

-- CreateIndex
CREATE INDEX "ledger_entries_tenant_id_reference_id_idx" ON "ledger_entries"("tenant_id", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_reservations_tenant_id_id_key" ON "credit_reservations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "credit_reservations_tenant_id_idx" ON "credit_reservations"("tenant_id");

-- CreateIndex
CREATE INDEX "credit_reservations_tenant_id_account_id_idx" ON "credit_reservations"("tenant_id", "account_id");

-- CreateIndex
CREATE INDEX "credit_reservations_tenant_id_status_idx" ON "credit_reservations"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "credit_reservations_reference_id_idx" ON "credit_reservations"("reference_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;