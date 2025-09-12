
import { Test, TestingModule } from '@nestjs/testing';
import { DlqConsumer } from './dlq.consumer';
import Redis from 'ioredis';
import * as dlqUtil from './utils/dlq.util';
import { MAX_DLQ_RETRIES } from '../constants';
import { Logger } from '@nestjs/common';

jest.mock('./utils/dlq.util');

const mockRetryFromDLQ = jest.mocked(dlqUtil.retryFromDLQ);
const mockMoveToDeadQueue = jest.mocked(dlqUtil.moveToDeadQueue);

describe('DlqConsumer', () => {
  let consumer: DlqConsumer;
  let mockRedis: jest.Mocked<Redis>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(async () => {
    mockRedis = {
      xread: jest.fn(),
      xdel: jest.fn(),
    } as any;

    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DlqConsumer,
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
        { provide: Logger, useValue: mockLogger },
      ],
    }).compile();

    consumer = module.get<DlqConsumer>(DlqConsumer);

    jest.clearAllMocks();
  });

  describe('onModuleInit', () => {
    it('should start DLQ processing on module init', async () => {
      const startProcessingSpy = jest.spyOn(consumer as any, 'startProcessing');

      await consumer.onModuleInit();

      expect(mockLogger.log).toHaveBeenCalledWith('Starting DLQ stream processor');
      expect(startProcessingSpy).toHaveBeenCalled();
    });
  });

  describe('processDLQ', () => {
    const apiName = 'danbooru';
    const dlqStream = `${apiName}-dlq`;

    beforeEach(() => {
      mockRetryFromDLQ.mockResolvedValue({ success: true });
      mockMoveToDeadQueue.mockResolvedValue(undefined);
    });

    it('should return when no entries in stream', async () => {
      mockRedis.xread.mockResolvedValue(null);

      await consumer['processDLQ']();

      expect(mockRedis.xread).toHaveBeenCalledWith(
        'BLOCK',
        5000,
        'STREAMS',
        dlqStream,
        '>',
        'COUNT',
        10,
      );
    });

    it('should process valid retryable DLQ entry', async () => {
      const streamId = '1640995200000-0';
      // Correct Redis XREAD format: [[streamName, [[id, [field1, value1], [field2, value2]], ...]]]
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                ['jobId', 'test-job-123'],
                ['error', 'No posts found'],
                ['query', 'rare:tag'],
                ['retryCount', '0'],
                ['originalError', 'API returned empty'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      mockRetryFromDLQ.mockResolvedValue({ success: true });
      mockRedis.xdel.mockResolvedValue(1);

      await consumer['processDLQ']();

      expect(mockRedis.xread).toHaveBeenCalledWith(
        'BLOCK',
        5000,
        'STREAMS',
        dlqStream,
        '>',
        'COUNT',
        10,
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Processing DLQ entry test-job-123: error = No posts found'),
      );

      expect(mockRetryFromDLQ).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'test-job-123',
        'rare:tag',
        0,
        streamId,
      );

      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('Successfully retried job test-job-123'),
      );

      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, streamId);
    });

    it('should increment retry count on subsequent attempts', async () => {
      const streamId = '1640995200000-0';
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                ['jobId', 'retry-job-456'],
                ['error', 'Rate limit exceeded'],
                ['query', 'popular:tag'],
                ['retryCount', '1'],
                ['originalError', 'HTTP 429'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      mockRetryFromDLQ.mockResolvedValue({ success: true });
      mockRedis.xdel.mockResolvedValue(1);

      await consumer['processDLQ']();

      expect(mockRetryFromDLQ).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'retry-job-456',
        'popular:tag',
        1,
        streamId,
      );

      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('Retrying job retry-job-456 from DLQ to main stream (attempt 2)'),
      );
    });

    it('should move to dead queue when max retries exceeded', async () => {
      const streamId = '1640995200000-0';
      const maxRetryCount = MAX_DLQ_RETRIES;
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                ['jobId', 'max-retry-job-789'],
                ['error', 'Permanent failure'],
                ['query', 'failed:tag'],
                ['retryCount', maxRetryCount.toString()],
                ['originalError', 'Database error'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      mockRedis.xdel.mockResolvedValue(1);

      await consumer['processDLQ']();

      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'max-retry-job-789',
        'Permanent failure',
        'failed:tag',
        'Database error',
      );

      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, streamId);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Job max-retry-job-789 moved to dead queue'),
      );
    });

    it('should move to dead queue for non-retryable errors', async () => {
      const streamId = '1640995200000-0';
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                ['jobId', 'non-retry-job-101'],
                ['error', 'Invalid authentication'],
                ['query', 'auth:fail'],
                ['retryCount', '0'],
                ['originalError', 'Invalid API key'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      mockRedis.xdel.mockResolvedValue(1);

      await consumer['processDLQ']();

      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'non-retry-job-101',
        'Invalid authentication',
        'auth:fail',
        'Invalid API key',
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Job non-retry-job-101 moved to dead queue'),
      );
    });

    it('should delete invalid DLQ entries', async () => {
      const streamId = '1640995200000-0';
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                // Missing required fields
                ['partialField', 'value'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      mockRedis.xdel.mockResolvedValue(1);

      await consumer['processDLQ']();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid DLQ entry'),
      );

      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, streamId);
    });

    it('should handle multiple DLQ entries in single batch', async () => {
      const streamId1 = '1640995200000-0';
      const streamId2 = '1640995201000-0';
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId1,
              [
                ['jobId', 'batch-job-1'],
                ['error', 'No posts found'],
                ['query', 'batch:query1'],
                ['retryCount', '0'],
              ],
            ],
            [
              streamId2,
              [
                ['jobId', 'batch-job-2'],
                ['error', 'Rate limit'],
                ['query', 'batch:query2'],
                ['retryCount', '1'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);

      mockRetryFromDLQ
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: 'Retry failed' });

      mockRedis.xdel
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1);

      await consumer['processDLQ']();

      expect(mockRetryFromDLQ).toHaveBeenCalledTimes(2);
      expect(mockRetryFromDLQ).toHaveBeenNthCalledWith(
        1,
        mockRedis,
        apiName,
        'batch-job-1',
        'batch:query1',
        0,
        streamId1,
      );
      expect(mockRetryFromDLQ).toHaveBeenNthCalledWith(
        2,
        mockRedis,
        apiName,
        'batch-job-2',
        'batch:query2',
        1,
        streamId2,
      );

      expect(mockRedis.xdel).toHaveBeenCalledTimes(2);
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
    });

    it('should handle xread errors gracefully', async () => {
      const redisError = new Error('Connection timeout');
      mockRedis.xread.mockRejectedValue(redisError);

      await consumer['processDLQ']();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('DLQ processing error: Connection timeout'),
      );
    });

    it('should handle xdel errors without stopping processing', async () => {
      const streamId = '1640995200000-0';
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                ['jobId', 'xdel-error-job'],
                ['error', 'Test error'],
                ['query', 'xdel:test'],
                ['retryCount', '0'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      const xdelError = new Error('XDEL failed');
      mockRedis.xdel.mockRejectedValue(xdelError);
      mockRetryFromDLQ.mockResolvedValue({ success: true });

      await consumer['processDLQ']();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('XDEL failed'),
      );
    });
  });

  describe('startProcessing', () => {
    it('should continuously process DLQ with 1 second intervals', async () => {
      const processDLQSpy = jest.spyOn(consumer as any, 'processDLQ').mockResolvedValue(undefined);

      jest.useFakeTimers();

      const processingPromise = consumer['startProcessing']();

      jest.advanceTimersByTime(2000);

      jest.useRealTimers();

      expect(processDLQSpy).toHaveBeenCalledTimes(2);

      await processingPromise.catch(() => {});
    }, 5000);

    it('should handle errors during continuous processing', async () => {
      const processDLQSpy = jest.spyOn(consumer as any, 'processDLQ');
      const error = new Error('Processing error');

      processDLQSpy
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(error);

      jest.useFakeTimers();

      const processingPromise = consumer['startProcessing']();
      jest.advanceTimersByTime(2000);
      jest.useRealTimers();

      expect(processDLQSpy).toHaveBeenCalledTimes(2);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('DLQ processing error: Processing error'),
      );

      await processingPromise.catch(() => {});
    }, 5000);
  });

  describe('retry logic', () => {
    const apiName = 'danbooru';
    const dlqStream = `${apiName}-dlq`;

    it('should retry "No posts found" errors', async () => {
      const streamId = '1640995200000-0';
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                ['jobId', 'no-posts-job'],
                ['error', 'No posts found for query'],
                ['query', 'empty:search'],
                ['retryCount', '0'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      mockRetryFromDLQ.mockResolvedValue({ success: true });
      mockRedis.xdel.mockResolvedValue(1);

      await consumer['processDLQ']();

      expect(mockRetryFromDLQ).toHaveBeenCalled();
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('Retrying job no-posts-job'),
      );
    });

    it('should retry "Rate limit" errors', async () => {
      const streamId = '1640995200000-0';
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                ['jobId', 'rate-limit-job'],
                ['error', 'Rate limit exceeded'],
                ['query', 'rate:limited'],
                ['retryCount', '0'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      mockRetryFromDLQ.mockResolvedValue({ success: true });
      mockRedis.xdel.mockResolvedValue(1);

      await consumer['processDLQ']();

      expect(mockRetryFromDLQ).toHaveBeenCalled();
    });

    it('should retry "API error" errors', async () => {
      const streamId = '1640995200000-0';
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                ['jobId', 'api-error-job'],
                ['error', 'API server error 500'],
                ['query', 'api:error'],
                ['retryCount', '0'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      mockRetryFromDLQ.mockResolvedValue({ success: true });
      mockRedis.xdel.mockResolvedValue(1);

      await consumer['processDLQ']();

      expect(mockRetryFromDLQ).toHaveBeenCalled();
    });

    it('should not retry non-retryable errors', async () => {
      const streamId = '1640995200000-0';
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                ['jobId', 'non-retry-job'],
                ['error', 'Invalid query syntax'],
                ['query', 'invalid:syntax'],
                ['retryCount', '0'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      mockRedis.xdel.mockResolvedValue(1);

      await consumer['processDLQ']();

      expect(mockRetryFromDLQ).not.toHaveBeenCalled();
      expect(mockMoveToDeadQueue).toHaveBeenCalled();
    });
  });

  describe('stream parsing', () => {
    const apiName = 'danbooru';
    const dlqStream = `${apiName}-dlq`;

    it('should correctly parse DLQ stream fields', async () => {
      const streamId = '1640995200000-0';
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                ['jobId', 'parse-test-job'],
                ['error', 'Parse test error'],
                ['query', 'parse:test'],
                ['retryCount', '2'],
                ['originalError', 'Original parse error'],
                ['extraField', 'ignored'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      mockRetryFromDLQ.mockResolvedValue({ success: true });
      mockRedis.xdel.mockResolvedValue(1);

      await consumer['processDLQ']();

      expect(mockRetryFromDLQ).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'parse-test-job',
        'parse:test',
        2,
        streamId,
      );

      expect(mockLogger.error).toHaveBeenCalledTimes(1);
    });

    it('should handle missing originalError field', async () => {
      const streamId = '1640995200000-0';
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                ['jobId', 'no-original-job'],
                ['error', 'No original error'],
                ['query', 'no:original'],
                ['retryCount', '0'],
                // Missing originalError
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      mockRetryFromDLQ.mockResolvedValue({ success: true });
      mockRedis.xdel.mockResolvedValue(1);

      await consumer['processDLQ']();

      expect(mockRetryFromDLQ).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'no-original-job',
        'no:original',
        0,
        streamId,
      );
    });
  });

  describe('error handling', () => {
    const apiName = 'danbooru';
    const dlqStream = `${apiName}-dlq`;

    it('should handle xread connection errors', async () => {
      const redisError = new Error('Connection timeout');
      mockRedis.xread.mockRejectedValue(redisError);

      await consumer['processDLQ']();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('DLQ processing error: Connection timeout'),
      );
    });

    it('should handle xdel errors without stopping processing', async () => {
      const streamId = '1640995200000-0';
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              [
                ['jobId', 'xdel-error-job'],
                ['error', 'Test error'],
                ['query', 'xdel:test'],
                ['retryCount', '0'],
              ],
            ],
          ],
        ],
      ];

      mockRedis.xread.mockResolvedValue(mockXReadResult);
      const xdelError = new Error('X
