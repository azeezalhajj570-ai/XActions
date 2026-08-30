-- CreateTable
CREATE TABLE "XGroupMember" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "xUserId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT,
    "profileUrl" TEXT,
    "avatarUrl" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isCurrentMember" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "XGroupMember_conversationId_idx" ON "XGroupMember"("conversationId");

-- CreateIndex
CREATE INDEX "XGroupMember_username_idx" ON "XGroupMember"("username");

-- CreateIndex
CREATE UNIQUE INDEX "XGroupMember_conversationId_xUserId_key" ON "XGroupMember"("conversationId", "xUserId");
