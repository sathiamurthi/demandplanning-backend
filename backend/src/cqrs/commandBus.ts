// ============================================================
// COMMAND BUS — ENTERPRISE CQRS IMPLEMENTATION
// ============================================================

export interface ICommand<TResponse = any> {
    type: string;
    [key: string]: any; 
  }
  
  export interface ICommandHandler<TCommand extends ICommand, TResponse = any> {
    execute(command: TCommand): Promise<TResponse>;
  }
  
  class CommandBus {
    private handlers = new Map<string, ICommandHandler<any, any>>();
  
    // ==========================================================
    // REGISTER HANDLER
    // ==========================================================
    register<TCommand extends ICommand, TResponse>(
      type: TCommand['type'],
      handler: ICommandHandler<TCommand, TResponse>
    ) {
      if (this.handlers.has(type)) {
        // ⚠️ Prevent crash in dev, enforce in prod
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`CommandBus: Handler already registered for "${type}"`);
        }
  
        console.warn(`⚠️ CommandBus: Duplicate handler skipped for "${type}"`);
        return;
      }
  
      this.handlers.set(type, handler);
    }
  
    // ==========================================================
    // EXECUTE COMMAND
    // ==========================================================
    async execute<TResponse = any>(command: ICommand<TResponse>): Promise<TResponse> {
      const handler = this.handlers.get(command.type);
  
      if (!handler) {
        throw new Error(`CommandBus: No handler found for "${command.type}"`);
      }
  
      return handler.execute(command);
    }
  
    // ==========================================================
    // DEBUG / INTROSPECTION
    // ==========================================================
    getRegisteredCommands(): string[] {
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
  
  export const commandBus = new CommandBus();