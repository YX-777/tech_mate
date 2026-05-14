import { PrismaClient } from '@prisma/client';
import { UserRepository } from './repositories/user.repository';
import { ConversationRepository, ConversationWithMessages } from './repositories/conversation.repository';
import { MessageRepository } from './repositories/message.repository';
import { TaskRepository } from './repositories/task.repository';
import { FocusSessionRepository } from './repositories/focus-session.repository';
import { LearningRecordRepository } from './repositories/learning-record.repository';
import { ModuleProgressRepository } from './repositories/module-progress.repository';
import { AgentStateRepository } from './repositories/agent-state.repository';
import { XhsPostRepository } from './repositories/xhs-post.repository';
import { XhsSyncRunRepository } from './repositories/xhs-sync-run.repository';
import { ShortTermMemoryRepository } from './repositories/short-term-memory.repository';
import { MetaMemoryRepository } from './repositories/meta-memory.repository';
import { PageViewRepository } from './repositories/page-view.repository';
import { EmbeddingService } from './services/embedding.service';
import { VectorDBService } from './services/vector-db.service';
import { XhsSyncService } from './services/xhs-sync.service';
import { LearningRecordService } from './services/learning-record.service';
import { TaskService } from './services/task.service';
import { StatsService } from './services/stats.service';
import { FocusService } from './services/focus.service';

let prisma: PrismaClient | null = null;
let embeddingService: EmbeddingService | null = null;
let vectorDBService: VectorDBService | null = null;

export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

export function getEmbeddingService(): EmbeddingService {
  if (!embeddingService) {
    embeddingService = new EmbeddingService();
  }
  return embeddingService;
}

export function getVectorDBService(): VectorDBService {
  if (!vectorDBService) {
    vectorDBService = new VectorDBService();
  }
  return vectorDBService;
}

export function getUserRepository(): UserRepository {
  return new UserRepository(getPrismaClient());
}

export function getConversationRepository(): ConversationRepository {
  return new ConversationRepository(getPrismaClient());
}

export function getMessageRepository(): MessageRepository {
  return new MessageRepository(getPrismaClient());
}

export function getTaskRepository(): TaskRepository {
  return new TaskRepository(getPrismaClient());
}

export function getFocusSessionRepository(): FocusSessionRepository {
  return new FocusSessionRepository(getPrismaClient());
}

export function getLearningRecordRepository(): LearningRecordRepository {
  return new LearningRecordRepository(getPrismaClient());
}

export function getModuleProgressRepository(): ModuleProgressRepository {
  return new ModuleProgressRepository(getPrismaClient());
}

export function getAgentStateRepository(): AgentStateRepository {
  // Agent 会话状态主仓储（单一真相源）。
  return new AgentStateRepository(getPrismaClient());
}

export function getXhsPostRepository(): XhsPostRepository {
  return new XhsPostRepository(getPrismaClient());
}

export function getXhsSyncRunRepository(): XhsSyncRunRepository {
  return new XhsSyncRunRepository(getPrismaClient());
}

export function getShortTermMemoryRepository(): ShortTermMemoryRepository {
  return new ShortTermMemoryRepository(getPrismaClient());
}

export function getMetaMemoryRepository(): MetaMemoryRepository {
  return new MetaMemoryRepository(getPrismaClient());
}

export function getPageViewRepository(): PageViewRepository {
  return new PageViewRepository(getPrismaClient());
}

export function getXhsSyncService(): XhsSyncService {
  return new XhsSyncService(getXhsPostRepository(), getXhsSyncRunRepository());
}

export function getLearningRecordService(): LearningRecordService {
  return new LearningRecordService(
    getUserRepository(),
    getLearningRecordRepository(),
    getModuleProgressRepository()
  );
}

export function getTaskService(): TaskService {
  return new TaskService(
    getUserRepository(),
    getTaskRepository(),
    getLearningRecordService()
  );
}

export function getStatsService(): StatsService {
  return new StatsService(
    getUserRepository(),
    getLearningRecordRepository(),
    getTaskRepository(),
    getModuleProgressRepository()
  );
}

export function getFocusService(): FocusService {
  return new FocusService(
    getUserRepository(),
    getFocusSessionRepository(),
    getLearningRecordService()
  );
}

export async function initializeDatabase(options?: { skipVectorDB?: boolean }): Promise<void> {
  if (!options?.skipVectorDB) {
    try {
      const { initializeVectorDB } = await import('./services/vector-db.loader');
      await initializeVectorDB();
    } catch (error) {
      console.warn('Failed to initialize VectorDB:', error);
    }
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
  embeddingService = null;
  vectorDBService = null;
}

export async function getSyncService(): Promise<any> {
  const syncLoader = await import('./services/sync.loader');
  return syncLoader.getSyncService();
}

export {
  UserRepository,
  ConversationRepository,
  MessageRepository,
  TaskRepository,
  FocusSessionRepository,
  LearningRecordRepository,
  ModuleProgressRepository,
  AgentStateRepository,
  XhsPostRepository,
  XhsSyncRunRepository,
  ShortTermMemoryRepository,
  MetaMemoryRepository,
  PageViewRepository,
  EmbeddingService,
  VectorDBService,
  XhsSyncService,
  LearningRecordService,
  TaskService,
  StatsService,
  FocusService
};

export type { ConversationWithMessages };

export * from '@prisma/client';
