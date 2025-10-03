/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Page} from 'puppeteer-core';
import z from 'zod';

import {PerformanceTraceFormatter} from '../../node_modules/chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceTraceFormatter.js';
import {AICallTree} from '../../node_modules/chrome-devtools-frontend/front_end/models/ai_assistance/performance/AICallTree.js';
import {AgentFocus} from '../../node_modules/chrome-devtools-frontend/front_end/models/ai_assistance/performance/AIContext.js';
import * as TraceEngine from '../../node_modules/chrome-devtools-frontend/front_end/models/trace/trace.js';
import {logger} from '../logger.js';
import type {InsightName} from '../trace-processing/parse.js';
import {
  getInsightOutput,
  getTraceSummary,
  parseRawTraceBuffer,
  traceResultIsSuccess,
} from '../trace-processing/parse.js';

import {ToolCategories} from './categories.js';
import type {Context, Response} from './ToolDefinition.js';
import {defineTool} from './ToolDefinition.js';

export const startTrace = defineTool({
  name: 'performance_start_trace',
  description:
    'Starts a performance trace recording on the selected page. This can be used to look for performance problems and insights to improve the performance of the page. It will also report Core Web Vital (CWV) scores for the page.',
  annotations: {
    category: ToolCategories.PERFORMANCE,
    readOnlyHint: true,
  },
  schema: {
    reload: z
      .boolean()
      .describe(
        'Determines if, once tracing has started, the page should be automatically reloaded.',
      ),
    autoStop: z
      .boolean()
      .describe(
        'Determines if the trace recording should be automatically stopped.',
      ),
  },
  handler: async (request, response, context) => {
    if (context.isRunningPerformanceTrace()) {
      response.appendResponseLine(
        'Error: a performance trace is already running. Use performance_stop_trace to stop it. Only one trace can be running at any given time.',
      );
      return;
    }
    context.setIsRunningPerformanceTrace(true);

    const page = context.getSelectedPage();
    const pageUrlForTracing = page.url();

    if (request.params.reload) {
      // Before starting the recording, navigate to about:blank to clear out any state.
      await page.goto('about:blank', {
        waitUntil: ['networkidle0'],
      });
    }

    // Keep in sync with the categories arrays in:
    // https://source.chromium.org/chromium/chromium/src/+/main:third_party/devtools-frontend/src/front_end/panels/timeline/TimelineController.ts
    // https://github.com/GoogleChrome/lighthouse/blob/master/lighthouse-core/gather/gatherers/trace.js
    const categories = [
      '-*',
      'blink.console',
      'blink.user_timing',
      'devtools.timeline',
      'disabled-by-default-devtools.screenshot',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.invalidationTracking',
      'disabled-by-default-devtools.timeline.frame',
      'disabled-by-default-devtools.timeline.stack',
      'disabled-by-default-v8.cpu_profiler',
      'disabled-by-default-v8.cpu_profiler.hires',
      'latencyInfo',
      'loading',
      'disabled-by-default-lighthouse',
      'v8.execute',
      'v8',
    ];
    await page.tracing.start({
      categories,
    });

    if (request.params.reload) {
      await page.goto(pageUrlForTracing, {
        waitUntil: ['load'],
      });
    }

    if (request.params.autoStop) {
      await new Promise(resolve => setTimeout(resolve, 5_000));
      await stopTracingAndAppendOutput(page, response, context);
    } else {
      response.appendResponseLine(
        `The performance trace is being recorded. Use performance_stop_trace to stop it.`,
      );
    }
  },
});

export const stopTrace = defineTool({
  name: 'performance_stop_trace',
  description:
    'Stops the active performance trace recording on the selected page.',
  annotations: {
    category: ToolCategories.PERFORMANCE,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (_request, response, context) => {
    if (!context.isRunningPerformanceTrace) {
      return;
    }
    const page = context.getSelectedPage();
    await stopTracingAndAppendOutput(page, response, context);
  },
});

export const analyzeInsight = defineTool({
  name: 'performance_analyze_insight',
  description:
    'Provides more detailed information on a specific Performance Insight that was highlighted in the results of a trace recording.',
  annotations: {
    category: ToolCategories.PERFORMANCE,
    readOnlyHint: true,
  },
  schema: {
    insightName: z
      .string()
      .describe(
        'The name of the Insight you want more information on. For example: "DocumentLatency" or "LCPBreakdown"',
      ),
  },
  handler: async (request, response, context) => {
    const lastRecording = context.recordedTraces().at(-1);
    if (!lastRecording) {
      response.appendResponseLine(
        'No recorded traces found. Record a performance trace so you have Insights to analyze.',
      );
      return;
    }

    const insightOutput = getInsightOutput(
      lastRecording,
      request.params.insightName as InsightName,
    );
    if ('error' in insightOutput) {
      response.appendResponseLine(insightOutput.error);
      return;
    }

    response.appendResponseLine(insightOutput.output);
  },
});

async function stopTracingAndAppendOutput(
  page: Page,
  response: Response,
  context: Context,
): Promise<void> {
  try {
    const traceEventsBuffer = await page.tracing.stop();
    const result = await parseRawTraceBuffer(traceEventsBuffer);
    response.appendResponseLine('The performance trace has been stopped.');
    if (traceResultIsSuccess(result)) {
      context.storeTraceRecording(result);
      response.appendResponseLine(
        'Here is a high level summary of the trace and the Insights that were found:',
      );
      const traceSummaryText = getTraceSummary(result);
      response.appendResponseLine(traceSummaryText);
    } else {
      response.appendResponseLine(
        'There was an unexpected error parsing the trace:',
      );
      response.appendResponseLine(result.error);
    }
  } catch (e) {
    const errorText = e instanceof Error ? e.message : JSON.stringify(e);
    logger(`Error stopping performance trace: ${errorText}`);
    response.appendResponseLine(
      'An error occurred generating the response for this trace:',
    );
    response.appendResponseLine(errorText);
  } finally {
    context.setIsRunningPerformanceTrace(false);
  }
}

export const getEventByKey = defineTool({
  name: 'performance_get_event_by_key',
  description:
    'Returns detailed information about a specific event. Use the detail returned to validate performance issues, but do not tell the user about irrelevant raw data from a trace event.',
  annotations: {
    category: ToolCategories.PERFORMANCE,
    readOnlyHint: true,
  },
  schema: {
    eventKey: z.string().describe('The key for the event.'),
  },
  handler: async (request, response, context) => {
    const trace = context.recordedTraces().at(-1);
    if (!trace) {
      response.appendResponseLine('Error: no trace recorded');
      return;
    }
    const focus = AgentFocus.fromParsedTrace(trace.parsedTrace);
    const event = focus.lookupEvent(
      request.params.eventKey as TraceEngine.Types.File.SerializableKey,
    );
    if (!event) {
      response.appendResponseLine('Error: no event with key found');
      return;
    }
    response.appendResponseLine(`Event:\n${JSON.stringify(event, null, 2)}`);
  },
});

export const getMainThreadTrackSummary = defineTool({
  name: 'performance_get_main_thread_track_summary',
  description:
    'Returns a summary of the main thread for the given bounds. The result includes a top-down summary, bottom-up summary, third-parties summary, and a list of related insights for the events within the given bounds.',
  annotations: {
    category: ToolCategories.PERFORMANCE,
    readOnlyHint: true,
  },
  schema: {
    min: z.number().describe('The minimum time of the bounds, in microseconds'),
    max: z.number().describe('The maximum time of the bounds, in microseconds'),
  },
  handler: async (request, response, context) => {
    const trace = context.recordedTraces().at(-1);
    if (!trace) {
      response.appendResponseLine('Error: no trace recorded');
      return;
    }
    const bounds = createBounds(
      trace.parsedTrace,
      request.params.min as TraceEngine.Types.Timing.Micro,
      request.params.max as TraceEngine.Types.Timing.Micro,
    );
    if (!bounds) {
      response.appendResponseLine('Erorr: invalid trace bounds');
      return;
    }

    const focus = AgentFocus.fromParsedTrace(trace.parsedTrace);
    const formatter = new PerformanceTraceFormatter(focus);
    response.appendResponseLine(formatter.formatMainThreadTrackSummary(bounds));
  },
});

export const getNetworkTrackSummary = defineTool({
  name: 'performance_get_network_track_summary',
  description: 'Returns a summary of the network for the given bounds.',
  annotations: {
    category: ToolCategories.PERFORMANCE,
    readOnlyHint: true,
  },
  schema: {
    min: z.number().describe('The minimum time of the bounds, in microseconds'),
    max: z.number().describe('The maximum time of the bounds, in microseconds'),
  },
  handler: async (request, response, context) => {
    const trace = context.recordedTraces().at(-1);
    if (!trace) {
      response.appendResponseLine('Error: no trace recorded');
      return;
    }
    const bounds = createBounds(
      trace.parsedTrace,
      request.params.min as TraceEngine.Types.Timing.Micro,
      request.params.max as TraceEngine.Types.Timing.Micro,
    );
    if (!bounds) {
      response.appendResponseLine('Erorr: invalid trace bounds');
      return;
    }

    const focus = AgentFocus.fromParsedTrace(trace.parsedTrace);
    const formatter = new PerformanceTraceFormatter(focus);
    response.appendResponseLine(formatter.formatNetworkTrackSummary(bounds));
  },
});

export const getDetailedCallTree = defineTool({
  name: 'performance_get_detailed_call_tree',
  description: 'Returns a detailed call tree for the given main thread event.',
  annotations: {
    category: ToolCategories.PERFORMANCE,
    readOnlyHint: true,
  },
  schema: {
    eventKey: z.string().describe('The key for the event.'),
  },
  handler: async (request, response, context) => {
    const trace = context.recordedTraces().at(-1);
    if (!trace) {
      response.appendResponseLine('Error: no trace recorded');
      return;
    }
    const focus = AgentFocus.fromParsedTrace(trace.parsedTrace);
    const event = focus.lookupEvent(
      request.params.eventKey as TraceEngine.Types.File.SerializableKey,
    );
    if (!event) {
      response.appendResponseLine('Error: no event with key found');
      return;
    }
    const formatter = new PerformanceTraceFormatter(focus);
    const tree = AICallTree.fromEvent(event, trace.parsedTrace);
    const callTree = tree
      ? formatter.formatCallTree(tree)
      : 'No call tree found';
    response.appendResponseLine(callTree);
  },
});

const createBounds = (
  trace: TraceEngine.TraceModel.ParsedTrace,
  min: TraceEngine.Types.Timing.Micro,
  max: TraceEngine.Types.Timing.Micro,
): TraceEngine.Types.Timing.TraceWindowMicro | null => {
  if (min > max) {
    return null;
  }

  const clampedMin = Math.max(min ?? 0, trace.data.Meta.traceBounds.min);
  const clampedMax = Math.min(
    max ?? Number.POSITIVE_INFINITY,
    trace.data.Meta.traceBounds.max,
  );
  if (clampedMin > clampedMax) {
    return null;
  }

  return TraceEngine.Helpers.Timing.traceWindowFromMicroSeconds(
    clampedMin as TraceEngine.Types.Timing.Micro,
    clampedMax as TraceEngine.Types.Timing.Micro,
  );
};

