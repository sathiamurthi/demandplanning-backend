"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReconciliationService = void 0;
const db_1 = require("../../config/db");
const logger_1 = require("../../config/logger");
class ReconciliationService {
    /**
     * Source Data Validation: Verify structural integrity and counts
     */
    static validateSourceData(payload) {
        if (!payload || !Array.isArray(payload)) {
            return { passed: false, expectedCount: 0, actualCount: 0, error: 'Invalid payload structure' };
        }
        if (payload.length === 0) {
            return { passed: false, expectedCount: 0, actualCount: 0, error: 'Empty payload' };
        }
        return { passed: true, expectedCount: payload.length, actualCount: payload.length };
    }
    /**
     * Source -> Target Reconciliation
     */
    static async reconcileSourceToTarget(batchId, expectedRowCount) {
        try {
            const dbResult = await (0, db_1.query)(`SELECT COUNT(*) as count FROM data360_rows WHERE batch_id = $1`, [batchId]);
            const actualCount = parseInt(dbResult[0]?.count || '0', 10);
            const passed = expectedRowCount === actualCount;
            await this.logReconciliation(batchId, 'source_to_target', passed, expectedRowCount, actualCount);
            return { passed, expectedCount: expectedRowCount, actualCount };
        }
        catch (error) {
            logger_1.logger.error(`Reconciliation failed for Source -> Target on batch ${batchId}`, error);
            return { passed: false, expectedCount: expectedRowCount, actualCount: 0, error: error.message };
        }
    }
    /**
     * ETL Reconciliation
     */
    static async reconcileEtl(batchId, intermediateCount, mappedData) {
        const actualCount = mappedData.length;
        const passed = intermediateCount === actualCount;
        await this.logReconciliation(batchId, 'etl_map', passed, intermediateCount, actualCount);
        return { passed, expectedCount: intermediateCount, actualCount };
    }
    /**
     * Report / Business Validation & Reconciliation
     */
    static async reconcileDistribution(batchId, approvedCount, successfullyDistributed) {
        const passed = approvedCount === successfullyDistributed;
        await this.logReconciliation(batchId, 'distribute_target', passed, approvedCount, successfullyDistributed);
        return { passed, expectedCount: approvedCount, actualCount: successfullyDistributed };
    }
    /**
     * Helper to log reconciliation events
     */
    static async logReconciliation(batchId, stage, passed, expected, actual) {
        try {
            await (0, db_1.query)(`
        INSERT INTO data360_reconciliation_logs (batch_id, stage, passed, expected_count, actual_count)
        VALUES ($1, $2, $3, $4, $5)
      `, [batchId, stage, passed, expected, actual]);
        }
        catch (e) {
            logger_1.logger.error(`Failed to insert reconciliation log for batch ${batchId}`, { error: e.message });
        }
    }
}
exports.ReconciliationService = ReconciliationService;
