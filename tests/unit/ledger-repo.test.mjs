// PaymentsRepository contract against the in-memory implementation.
import { MemoryPaymentsData, MemoryPaymentsRepository } from '../../apps/mcp-server/dist/ledger/index.js';
import { runLedgerContract } from './ledger-contract.mjs';

let clock = Date.parse('2026-10-05T12:00:00Z');
const repo = new MemoryPaymentsRepository(new MemoryPaymentsData(), () => (clock += 1000));

runLedgerContract('memory ledger', { withRepo: (fn) => fn(repo) });
