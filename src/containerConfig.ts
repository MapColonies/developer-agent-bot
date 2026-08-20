import { getOtelMixin } from '@map-colonies/tracing-utils';
import { trace } from '@opentelemetry/api';
import { Registry } from 'prom-client';
import type { DependencyContainer } from 'tsyringe/dist/typings/types';
import { jsLogger } from '@map-colonies/js-logger';
import { type InjectionObject, registerDependencies } from '@common/dependencyRegistration';
import { SERVICES, SERVICE_NAME } from '@common/constants';
import { getConfig } from './common/config';

export interface RegisterOptions {
  override?: InjectionObject<unknown>[];
  useChild?: boolean;
}

export const registerExternalValues = async (options?: RegisterOptions): Promise<DependencyContainer> => {
  const configInstance = getConfig();

  const loggerConfig = configInstance.get('telemetry.logger');

  const logger = await jsLogger({ ...loggerConfig, prettyPrint: loggerConfig.prettyPrint, mixin: getOtelMixin() });

  const tracer = trace.getTracer(SERVICE_NAME);
  const metricsRegistry = new Registry();
  configInstance.initializeMetrics(metricsRegistry);

  const dependencies: InjectionObject<unknown>[] = [
    { token: SERVICES.CONFIG, provider: { useValue: configInstance } },
    { token: SERVICES.LOGGER, provider: { useValue: logger } },
    { token: SERVICES.TRACER, provider: { useValue: tracer } },
    { token: SERVICES.METRICS, provider: { useValue: metricsRegistry } },
  ];

  return Promise.resolve(registerDependencies(dependencies, options?.override, options?.useChild));
};
