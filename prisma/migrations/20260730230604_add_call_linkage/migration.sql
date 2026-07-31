-- AlterTable
ALTER TABLE "call_transcripts" ADD COLUMN     "recording_url" TEXT;

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "vapi_call_id" VARCHAR(128);

-- CreateIndex
CREATE INDEX "patients_vapi_call_id_idx" ON "patients"("vapi_call_id");
