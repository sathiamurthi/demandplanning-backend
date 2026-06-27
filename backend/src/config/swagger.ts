// ============================================================
// swagger.ts — OpenAPI 3.0 spec + Swagger UI endpoint
// Served at: GET /v1/api-docs      → Swagger UI HTML
//            GET /v1/api-docs/spec → Raw OpenAPI JSON
// ============================================================
import { Router } from 'express';

export const swaggerRouter = Router();

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'Demand Planning API',
    version: '2.0.0',
    description: 'Enterprise demand planning, inventory management, and AI forecasting API',
    contact: { name: 'ASG Team' },
  },
  servers: [{ url: '/v1', description: 'API v1' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      ApiSuccess: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { type: 'object' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      ApiError: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      Item: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'Paracetamol 500mg' },
          sku: { type: 'string', example: 'MED-0001' },
          barcode: { type: 'string', nullable: true },
          brand: { type: 'string', nullable: true },
          description: { type: 'string', nullable: true },
          currentStock: { type: 'number', example: 150 },
          reorderLevel: { type: 'number', example: 20 },
          maxStockLevel: { type: 'number', nullable: true },
          sellingPrice: { type: 'number', example: 25.5 },
          purchasePrice: { type: 'number', nullable: true },
          mrp: { type: 'number', nullable: true },
          gstRate: { type: 'number', example: 5 },
          expiryDate: { type: 'string', format: 'date', nullable: true },
          batchNumber: { type: 'string', nullable: true },
          isActive: { type: 'boolean', example: true },
          categoryName: { type: 'string', nullable: true },
          supplierName: { type: 'string', nullable: true },
          unitSymbol: { type: 'string', example: 'pc' },
          isLowStock: { type: 'boolean' },
          isExpiring: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      ItemCreate: {
        type: 'object',
        required: ['name', 'currentStock'],
        properties: {
          name: { type: 'string', example: 'Paracetamol 500mg' },
          sku: { type: 'string' },
          barcode: { type: 'string' },
          brand: { type: 'string' },
          description: { type: 'string' },
          categoryId: { type: 'string', format: 'uuid' },
          supplierId: { type: 'string', format: 'uuid' },
          currentStock: { type: 'number', minimum: 0, example: 100 },
          reorderLevel: { type: 'number', minimum: 0, example: 10 },
          maxStockLevel: { type: 'number' },
          leadTimeDays: { type: 'number' },
          primaryUnitId: { type: 'string', format: 'uuid' },
          sellingPrice: { type: 'number' },
          purchasePrice: { type: 'number' },
          mrp: { type: 'number' },
          gstRate: { type: 'number', example: 5 },
          expiryDate: { type: 'string', format: 'date' },
          batchNumber: { type: 'string' },
          isSeasonal: { type: 'boolean' },
        },
      },
      ItemQuickCreate: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', example: 'Paracetamol 500mg' },
          sku: { type: 'string', description: 'Leave blank to auto-generate' },
          sellingPrice: { type: 'number', example: 25.5 },
          currentStock: { type: 'number', example: 0 },
        },
      },
      ItemImportRow: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          sku: { type: 'string' },
          currentStock: { type: 'number' },
          sellingPrice: { type: 'number' },
          purchasePrice: { type: 'number' },
          reorderLevel: { type: 'number' },
          expiryDate: { type: 'string', format: 'date' },
        },
      },
      ForecastResult: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          item: { type: 'string' },
          predictedQty30d: { type: 'integer' },
          confidencePct: { type: 'integer', minimum: 0, maximum: 100 },
          orderNeeded: { type: 'boolean' },
          orderQty: { type: 'integer' },
          riskLevel: { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
          reasoning: { type: 'string' },
        },
      },
      AISuggestResponse: {
        type: 'object',
        properties: {
          suggestedSku: { type: 'string' },
          suggestedCategory: { type: 'string' },
          suggestedReorderLevel: { type: 'number' },
          estimatedPriceRange: {
            type: 'object',
            properties: { min: { type: 'number' }, max: { type: 'number' } },
          },
          isSeasonal: { type: 'boolean' },
          notes: { type: 'string' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login and get JWT token',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                  tenantSlug: { type: 'string', description: 'Required for tenant users' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Login successful, returns JWT token' },
          401: { description: 'Invalid credentials' },
        },
      },
    },
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new tenant account',
        security: [],
        responses: { 201: { description: 'Account created' } },
      },
    },
    '/tenants/{tenantId}/stores/{storeId}/items': {
      get: {
        tags: ['Items'],
        summary: 'List all items for a store',
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search by name/SKU/barcode' },
          { name: 'lowStock', in: 'query', schema: { type: 'boolean' }, description: 'Filter low stock only' },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: {
          200: {
            description: 'Paginated item list',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } } },
          },
        },
      },
      post: {
        tags: ['Items'],
        summary: 'Create a new item (full form)',
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ItemCreate' } } },
        },
        responses: {
          201: { description: 'Item created' },
          400: { description: 'Validation error' },
        },
      },
    },
    '/tenants/{tenantId}/stores/{storeId}/items/quick': {
      post: {
        tags: ['Items'],
        summary: 'Quick-add an item with minimal fields',
        description: 'Create an item using only name, SKU (optional), price, and stock. Ideal for rapid data entry.',
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ItemQuickCreate' } } },
        },
        responses: {
          201: { description: 'Item created' },
          400: { description: 'Validation error' },
        },
      },
    },
    '/tenants/{tenantId}/stores/{storeId}/items/import/template': {
      get: {
        tags: ['Items'],
        summary: 'Download CSV import template',
        description: 'Returns a CSV file with headers and example rows for bulk item upload.',
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'CSV file',
            content: { 'text/csv': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/tenants/{tenantId}/stores/{storeId}/items/import': {
      post: {
        tags: ['Items'],
        summary: 'Bulk import items from CSV data',
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/ItemImportRow' },
                  },
                  mode: {
                    type: 'string',
                    enum: ['insert_only', 'upsert'],
                    default: 'upsert',
                    description: 'upsert: update if SKU exists, insert_only: skip duplicates',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Import summary',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    created: { type: 'integer' },
                    updated: { type: 'integer' },
                    errors: { type: 'array', items: { type: 'object' } },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/tenants/{tenantId}/stores/{storeId}/items/{itemId}': {
      get: {
        tags: ['Items'],
        summary: 'Get a single item by ID',
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Item detail' }, 404: { description: 'Not found' } },
      },
      put: {
        tags: ['Items'],
        summary: 'Update an item',
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Item updated' } },
      },
      delete: {
        tags: ['Items'],
        summary: 'Deactivate an item (soft delete)',
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Item deactivated' } },
      },
    },
    '/tenants/{tenantId}/stores/{storeId}/items/low-stock': {
      get: {
        tags: ['Items'],
        summary: 'Get items at or below reorder level',
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Low stock items list' } },
      },
    },
    '/stores/{storeId}/report/generate': {
      post: {
        tags: ['AI Forecast'],
        summary: 'Generate AI demand forecast',
        parameters: [
          { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: { type: 'string', format: 'email', description: 'Notify email for results' },
                  itemIds: { type: 'array', items: { type: 'string' }, description: 'Specific items to forecast (optional)' },
                  includeExpiring: { type: 'boolean', default: true },
                  includeSeasonal: { type: 'boolean', default: true },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Forecast results' } },
      },
    },
    '/stores/{storeId}/report/suggest': {
      post: {
        tags: ['AI Forecast'],
        summary: 'Get AI suggestions for item fields',
        description: 'Given an item name, Claude AI suggests SKU format, reorder level, price range, and seasonality.',
        parameters: [
          { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', example: 'Paracetamol 500mg' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'AI suggested fields',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AISuggestResponse' } } },
          },
        },
      },
    },
    '/stores/{storeId}/report/search': {
      get: {
        tags: ['AI Forecast'],
        summary: 'Semantic AI search across items',
        parameters: [
          { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Natural language query' },
        ],
        responses: { 200: { description: 'Search results (DB + AI fallback)' } },
      },
    },
    '/alerts': {
      get: {
        tags: ['Alerts'],
        summary: 'Get AI-generated alerts (low stock, expiry, seasonal)',
        parameters: [
          { name: 'storeId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['low_stock', 'expiry', 'seasonal', 'reorder'] } },
          { name: 'resolved', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { 200: { description: 'Alert list' } },
      },
    },
    '/tenants': {
      get: {
        tags: ['Tenants'],
        summary: 'List all tenants (superadmin only)',
        responses: { 200: { description: 'Tenant list' }, 403: { description: 'Forbidden' } },
      },
    },
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        security: [],
        responses: { 200: { description: 'Service is healthy' } },
      },
    },
  },
} as const;

// Serve spec as JSON
swaggerRouter.get('/spec', (_req, res) => {
  res.json(spec);
});

// Serve Swagger UI (CDN-based, no package needed)
swaggerRouter.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Demand Planning API — Swagger UI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; background: #fafafa; }
    .swagger-ui .topbar { background: #1C1A2E; }
    .swagger-ui .topbar .download-url-wrapper .select-label select { border-color: #D4A843; }
    .swagger-ui .topbar-wrapper img { display: none; }
    .swagger-ui .topbar-wrapper::after {
      content: 'Demand Planning API';
      color: #D4A843;
      font-size: 1.2rem;
      font-weight: 700;
      font-family: system-ui, sans-serif;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/v1/api-docs/spec',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout',
      deepLinking: true,
      filter: true,
    });
  </script>
</body>
</html>`);
});
