// ============================================================
// QUERY BUS — ENTERPRISE CQRS IMPLEMENTATION
// ============================================================

export interface IQuery<TResponse = any> {
  type: string;
  [key: string]: any; 
}

export interface IQueryHandler<TQuery extends IQuery, TResponse = any> {
  execute(query: TQuery): Promise<TResponse>;
}

class QueryBus {
  private handlers = new Map<string, IQueryHandler<any, any>>();

  // ==========================================================
  // REGISTER HANDLER
  // ==========================================================
  register<TQuery extends IQuery, TResponse>(
    type: TQuery['type'],
    handler: IQueryHandler<TQuery, TResponse>
  ) {
    if (this.handlers.has(type)) {
      // ⚠️ Prevent crash in dev, enforce in prod
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`QueryBus: Handler already registered for "${type}"`);
      }

      console.warn(`⚠️ QueryBus: Duplicate handler skipped for "${type}"`);
      return;
    }

    this.handlers.set(type, handler);
  }

  // ==========================================================
  // EXECUTE QUERY
  // ==========================================================
  async execute<TResponse = any>(query: IQuery<TResponse>): Promise<TResponse> {
    const handler = this.handlers.get(query.type);

    if (!handler) {
      throw new Error(`QueryBus: No handler found for "${query.type}"`);
    }

    return handler.execute(query);
  }

  // ==========================================================
  // DEBUG / INTROSPECTION
  // ==========================================================
  getRegisteredQueries(): string[] {
    return Array.from(this.handlers.keys());
  }

  hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }

  clear() {
    this.handlers.clear();
  }
}

// ============================================================
// SINGLETON EXPORT
// ============================================================

export const queryBus = new QueryBus();