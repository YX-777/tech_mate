import { LearningRecordRepository } from "../repositories/learning-record.repository";
import { ModuleProgressRepository } from "../repositories/module-progress.repository";
import { TaskRepository } from "../repositories/task.repository";
import { UserRepository } from "../repositories/user.repository";

export interface StatsSummaryResult {
  totalHours: number;
  avgAccuracy: number;
  consecutiveDays: number;
  completedTasks: number;
  progressPercentage: number;
  studyDays: number;
  remainingDays: number | null;
}

export interface DashboardSuggestion {
  level: "info" | "warning" | "success";
  title: string;
  description: string;
}

export interface CalendarDaySummary {
  date: string;
  learningHours: number;
  completed: boolean;
}

export interface AccuracyTrendPoint {
  date: string;
  accuracy: number;
}

export interface ModuleAccuracyItem {
  name: string;
  accuracy: number;
  totalQuestions: number;
  correctAnswers: number;
}

function buildDashboardSuggestion(input: {
  modules: ModuleAccuracyItem[];
  totalHours: number;
  consecutiveDays: number;
  remainingDays: number | null;
}): DashboardSuggestion {
  const { modules, totalHours, consecutiveDays, remainingDays } = input;
  const weakestModule = [...modules].sort((a, b) => a.accuracy - b.accuracy)[0];
  const strongestModule = [...modules].sort((a, b) => b.accuracy - a.accuracy)[0];

  if (weakestModule && weakestModule.accuracy < 70) {
    return {
      level: "warning",
      title: "优先补弱模块",
      description: `当前 ${weakestModule.name} 正确率只有 ${weakestModule.accuracy}%，建议下一轮任务优先补这部分；${
        strongestModule && strongestModule.name !== weakestModule.name
          ? `${strongestModule.name} 相对更稳，可以暂时维持。`
          : "先把薄弱模块的基础题做扎实。"
      }`,
    };
  }

  if (remainingDays !== null && remainingDays <= 30) {
    return {
      level: "warning",
      title: "临近目标节点，保持稳定节奏",
      description: `距离目标还剩 ${remainingDays} 天，建议把重点放在高频模块复盘和错题回顾上，减少临时大范围切换任务。`,
    };
  }

  if (consecutiveDays >= 5) {
    return {
      level: "success",
      title: "学习节奏保持得不错",
      description: `你已经连续学习 ${consecutiveDays} 天，当前累计学习 ${totalHours} 小时。继续按现在的节奏推进，优先巩固已有正确率优势的模块。`,
    };
  }

  return {
    level: "info",
    title: "先把稳定学习节奏建立起来",
    description: `当前累计学习 ${totalHours} 小时，建议先保证每天都有稳定输入，再逐步把任务量和专项训练拉起来。`,
  };
}

function getRangeStart(range: "week" | "month" | "all"): Date | undefined {
  const now = new Date();
  if (range === "all") {
    return undefined;
  }

  const start = new Date(now);
  if (range === "week") {
    start.setDate(start.getDate() - 6);
  } else {
    start.setMonth(start.getMonth() - 1);
  }
  start.setHours(0, 0, 0, 0);
  return start;
}

function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class StatsService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly learningRecordRepository: LearningRecordRepository,
    private readonly taskRepository: TaskRepository,
    private readonly moduleProgressRepository: ModuleProgressRepository
  ) {}

  async getStatsSummary(userId: string, range: "week" | "month" | "all" = "month"): Promise<StatsSummaryResult> {
    await this.userRepository.findOrCreateUser(userId);

    const startDate = getRangeStart(range);
    const endDate = new Date();

    const [learningStats, consecutiveDays, allTasks, completedTasks, profile] = await Promise.all([
      this.learningRecordRepository.getLearningStats(userId, startDate, endDate),
      this.learningRecordRepository.getConsecutiveDays(userId),
      this.taskRepository.findByUserId(userId),
      startDate
        ? this.taskRepository.getCompletedTasks(userId, startDate, endDate)
        : this.taskRepository.findByUserId(userId, { status: "completed" }),
      this.userRepository.getUserProfile(userId),
    ]);

    const totalTasks = allTasks.length;
    const progressPercentage = totalTasks > 0
      ? Math.round((completedTasks.length / totalTasks) * 100)
      : 0;

    let remainingDays: number | null = null;
    if (profile?.examDate) {
      const diffMs = profile.examDate.getTime() - Date.now();
      remainingDays = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    }

    return {
      totalHours: Number(learningStats.totalHours.toFixed(1)),
      avgAccuracy: learningStats.averageAccuracy,
      consecutiveDays,
      completedTasks: completedTasks.length,
      progressPercentage,
      studyDays: learningStats.totalDays,
      remainingDays,
    };
  }

  async getCalendarDays(userId: string, year: number, month: number): Promise<CalendarDaySummary[]> {
    await this.userRepository.findOrCreateUser(userId);

    const monthStart = new Date(year, month, 1, 0, 0, 0, 0);
    const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999);
    const records = await this.learningRecordRepository.findByUserId(userId, monthStart, monthEnd);

    const recordMap = new Map<string, CalendarDaySummary>();
    for (const record of records) {
      const key = formatLocalDateKey(new Date(record.date));
      const existing = recordMap.get(key);
      if (existing) {
        existing.learningHours = Number((existing.learningHours + record.learningHours).toFixed(1));
        existing.completed = existing.completed || record.completed || record.learningHours > 0;
      } else {
        recordMap.set(key, {
          date: key,
          learningHours: Number(record.learningHours.toFixed(1)),
          completed: record.completed || record.learningHours > 0,
        });
      }
    }

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: daysInMonth }, (_, index) => {
      const date = new Date(year, month, index + 1);
      const key = formatLocalDateKey(date);
      return recordMap.get(key) ?? {
        date: key,
        learningHours: 0,
        completed: false,
      };
    });
  }

  async getAccuracyTrend(userId: string, range: "week" | "month" | "all" = "month"): Promise<AccuracyTrendPoint[]> {
    await this.userRepository.findOrCreateUser(userId);

    const startDate = getRangeStart(range);
    const endDate = new Date();
    const records = await this.learningRecordRepository.findByUserId(userId, startDate, endDate);

    const grouped = new Map<string, { totalAccuracy: number; count: number }>();
    for (const record of records) {
      if (typeof record.accuracy !== "number") continue;
      const key = formatLocalDateKey(new Date(record.date));
      const existing = grouped.get(key) ?? { totalAccuracy: 0, count: 0 };
      existing.totalAccuracy += record.accuracy * 100;
      existing.count += 1;
      grouped.set(key, existing);
    }

    const sortedKeys = [...grouped.keys()].sort();
    const selectedKeys = range === "all" ? sortedKeys.slice(-7) : sortedKeys;

    return selectedKeys.map((key) => {
      const item = grouped.get(key)!;
      return {
        date: key.slice(5),
        accuracy: Number((item.totalAccuracy / item.count).toFixed(1)),
      };
    });
  }

  async getModuleAccuracy(userId: string): Promise<ModuleAccuracyItem[]> {
    await this.userRepository.findOrCreateUser(userId);

    const modules = await this.moduleProgressRepository.findByUserId(userId);
    return modules.map((module) => ({
      name: module.moduleName,
      accuracy: Number(module.accuracy.toFixed(1)),
      totalQuestions: module.totalQuestions,
      correctAnswers: module.correctAnswers,
    }));
  }

  async getDashboardSuggestion(userId: string, range: "week" | "month" | "all" = "month"): Promise<DashboardSuggestion> {
    const [stats, modules] = await Promise.all([
      this.getStatsSummary(userId, range),
      this.getModuleAccuracy(userId),
    ]);

    return buildDashboardSuggestion({
      modules,
      totalHours: stats.totalHours,
      consecutiveDays: stats.consecutiveDays,
      remainingDays: stats.remainingDays,
    });
  }
}
