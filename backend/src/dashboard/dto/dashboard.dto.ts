export type DashboardDto = {
  totalItems: number;
  stockValue: number;
  lowStock: number;
  todaySales: number;
  salesTrend: { day: string; total: number }[];
  lowStockItems: { name: string; current_stock: number }[];
  alerts: { message: string; severity: string }[];
  forecast: { name: string; predicted_qty_30d: number; risk_level: string }[];
};