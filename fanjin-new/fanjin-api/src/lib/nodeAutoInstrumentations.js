// Adapted from @opentelemetry/auto-instrumentations-node 0.81.0.
// Copyright The OpenTelemetry Authors; Apache-2.0.
// Only unused cloud resource-detector imports/exports removed. Instrumentation behavior unchanged.
"use strict";
/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNodeAutoInstrumentations = void 0;
const api_1 = require("@opentelemetry/api");
const instrumentation_amqplib_1 = require("@opentelemetry/instrumentation-amqplib");
const instrumentation_aws_lambda_1 = require("@opentelemetry/instrumentation-aws-lambda");
const instrumentation_aws_sdk_1 = require("@opentelemetry/instrumentation-aws-sdk");
const instrumentation_bunyan_1 = require("@opentelemetry/instrumentation-bunyan");
const instrumentation_cassandra_driver_1 = require("@opentelemetry/instrumentation-cassandra-driver");
const instrumentation_connect_1 = require("@opentelemetry/instrumentation-connect");
const instrumentation_cucumber_1 = require("@opentelemetry/instrumentation-cucumber");
const instrumentation_dataloader_1 = require("@opentelemetry/instrumentation-dataloader");
const instrumentation_dns_1 = require("@opentelemetry/instrumentation-dns");
const instrumentation_express_1 = require("@opentelemetry/instrumentation-express");
const instrumentation_fs_1 = require("@opentelemetry/instrumentation-fs");
const instrumentation_generic_pool_1 = require("@opentelemetry/instrumentation-generic-pool");
const instrumentation_graphql_1 = require("@opentelemetry/instrumentation-graphql");
const instrumentation_grpc_1 = require("@opentelemetry/instrumentation-grpc");
const instrumentation_hapi_1 = require("@opentelemetry/instrumentation-hapi");
const instrumentation_host_metrics_1 = require("@opentelemetry/instrumentation-host-metrics");
const instrumentation_http_1 = require("@opentelemetry/instrumentation-http");
const instrumentation_ioredis_1 = require("@opentelemetry/instrumentation-ioredis");
const instrumentation_kafkajs_1 = require("@opentelemetry/instrumentation-kafkajs");
const instrumentation_knex_1 = require("@opentelemetry/instrumentation-knex");
const instrumentation_koa_1 = require("@opentelemetry/instrumentation-koa");
const instrumentation_lru_memoizer_1 = require("@opentelemetry/instrumentation-lru-memoizer");
const instrumentation_memcached_1 = require("@opentelemetry/instrumentation-memcached");
const instrumentation_mongodb_1 = require("@opentelemetry/instrumentation-mongodb");
const instrumentation_mongoose_1 = require("@opentelemetry/instrumentation-mongoose");
const instrumentation_mysql2_1 = require("@opentelemetry/instrumentation-mysql2");
const instrumentation_mysql_1 = require("@opentelemetry/instrumentation-mysql");
const instrumentation_nestjs_core_1 = require("@opentelemetry/instrumentation-nestjs-core");
const instrumentation_net_1 = require("@opentelemetry/instrumentation-net");
const instrumentation_openai_1 = require("@opentelemetry/instrumentation-openai");
const instrumentation_oracledb_1 = require("@opentelemetry/instrumentation-oracledb");
const instrumentation_pg_1 = require("@opentelemetry/instrumentation-pg");
const instrumentation_pino_1 = require("@opentelemetry/instrumentation-pino");
const instrumentation_redis_1 = require("@opentelemetry/instrumentation-redis");
const instrumentation_restify_1 = require("@opentelemetry/instrumentation-restify");
const instrumentation_router_1 = require("@opentelemetry/instrumentation-router");
const instrumentation_runtime_node_1 = require("@opentelemetry/instrumentation-runtime-node");
const instrumentation_socket_io_1 = require("@opentelemetry/instrumentation-socket.io");
const instrumentation_tedious_1 = require("@opentelemetry/instrumentation-tedious");
const instrumentation_undici_1 = require("@opentelemetry/instrumentation-undici");
const instrumentation_winston_1 = require("@opentelemetry/instrumentation-winston");
const InstrumentationMap = {
    '@opentelemetry/instrumentation-amqplib': instrumentation_amqplib_1.AmqplibInstrumentation,
    '@opentelemetry/instrumentation-aws-lambda': instrumentation_aws_lambda_1.AwsLambdaInstrumentation,
    '@opentelemetry/instrumentation-aws-sdk': instrumentation_aws_sdk_1.AwsInstrumentation,
    '@opentelemetry/instrumentation-bunyan': instrumentation_bunyan_1.BunyanInstrumentation,
    '@opentelemetry/instrumentation-cassandra-driver': instrumentation_cassandra_driver_1.CassandraDriverInstrumentation,
    '@opentelemetry/instrumentation-connect': instrumentation_connect_1.ConnectInstrumentation,
    '@opentelemetry/instrumentation-cucumber': instrumentation_cucumber_1.CucumberInstrumentation,
    '@opentelemetry/instrumentation-dataloader': instrumentation_dataloader_1.DataloaderInstrumentation,
    '@opentelemetry/instrumentation-dns': instrumentation_dns_1.DnsInstrumentation,
    '@opentelemetry/instrumentation-express': instrumentation_express_1.ExpressInstrumentation,
    '@opentelemetry/instrumentation-fs': instrumentation_fs_1.FsInstrumentation,
    '@opentelemetry/instrumentation-generic-pool': instrumentation_generic_pool_1.GenericPoolInstrumentation,
    '@opentelemetry/instrumentation-graphql': instrumentation_graphql_1.GraphQLInstrumentation,
    '@opentelemetry/instrumentation-grpc': instrumentation_grpc_1.GrpcInstrumentation,
    '@opentelemetry/instrumentation-hapi': instrumentation_hapi_1.HapiInstrumentation,
    '@opentelemetry/instrumentation-host-metrics': instrumentation_host_metrics_1.HostMetricsInstrumentation,
    '@opentelemetry/instrumentation-http': instrumentation_http_1.HttpInstrumentation,
    '@opentelemetry/instrumentation-ioredis': instrumentation_ioredis_1.IORedisInstrumentation,
    '@opentelemetry/instrumentation-kafkajs': instrumentation_kafkajs_1.KafkaJsInstrumentation,
    '@opentelemetry/instrumentation-knex': instrumentation_knex_1.KnexInstrumentation,
    '@opentelemetry/instrumentation-koa': instrumentation_koa_1.KoaInstrumentation,
    '@opentelemetry/instrumentation-lru-memoizer': instrumentation_lru_memoizer_1.LruMemoizerInstrumentation,
    '@opentelemetry/instrumentation-memcached': instrumentation_memcached_1.MemcachedInstrumentation,
    '@opentelemetry/instrumentation-mongodb': instrumentation_mongodb_1.MongoDBInstrumentation,
    '@opentelemetry/instrumentation-mongoose': instrumentation_mongoose_1.MongooseInstrumentation,
    '@opentelemetry/instrumentation-mysql2': instrumentation_mysql2_1.MySQL2Instrumentation,
    '@opentelemetry/instrumentation-mysql': instrumentation_mysql_1.MySQLInstrumentation,
    '@opentelemetry/instrumentation-nestjs-core': instrumentation_nestjs_core_1.NestInstrumentation,
    '@opentelemetry/instrumentation-net': instrumentation_net_1.NetInstrumentation,
    '@opentelemetry/instrumentation-openai': instrumentation_openai_1.OpenAIInstrumentation,
    '@opentelemetry/instrumentation-oracledb': instrumentation_oracledb_1.OracleInstrumentation,
    '@opentelemetry/instrumentation-pg': instrumentation_pg_1.PgInstrumentation,
    '@opentelemetry/instrumentation-pino': instrumentation_pino_1.PinoInstrumentation,
    '@opentelemetry/instrumentation-redis': instrumentation_redis_1.RedisInstrumentation,
    '@opentelemetry/instrumentation-restify': instrumentation_restify_1.RestifyInstrumentation,
    '@opentelemetry/instrumentation-router': instrumentation_router_1.RouterInstrumentation,
    '@opentelemetry/instrumentation-runtime-node': instrumentation_runtime_node_1.RuntimeNodeInstrumentation,
    '@opentelemetry/instrumentation-socket.io': instrumentation_socket_io_1.SocketIoInstrumentation,
    '@opentelemetry/instrumentation-tedious': instrumentation_tedious_1.TediousInstrumentation,
    '@opentelemetry/instrumentation-undici': instrumentation_undici_1.UndiciInstrumentation,
    '@opentelemetry/instrumentation-winston': instrumentation_winston_1.WinstonInstrumentation,
};
const defaultExcludedInstrumentations = [
    '@opentelemetry/instrumentation-fs',
    '@opentelemetry/instrumentation-host-metrics',
];
function shouldDisableInstrumentation(name, userConfig, enabledInstrumentationsFromEnv, disabledInstrumentationsFromEnv) {
    // Priority 1: Programmatic config
    if (userConfig.enabled === false) {
        api_1.diag.debug(`Disabling instrumentation for ${name} - disabled by user config`);
        return true;
    }
    if (userConfig.enabled === true) {
        api_1.diag.debug(`Enabling instrumentation for ${name} - explicitly enabled by user config`);
        return false;
    }
    // Priority 2: Environment variables
    if (disabledInstrumentationsFromEnv.includes(name)) {
        api_1.diag.debug(`Disabling instrumentation for ${name} - disabled by env var`);
        return true;
    }
    const isEnabledEnvSet = !!process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
    if (isEnabledEnvSet && !enabledInstrumentationsFromEnv.includes(name)) {
        api_1.diag.debug(`Disabling instrumentation for ${name} - not in enabled env var list`);
        return true;
    }
    // Priority 3: Default exclusions
    if (!isEnabledEnvSet && defaultExcludedInstrumentations.includes(name)) {
        api_1.diag.debug(`Disabling instrumentation for ${name} - excluded by default`);
        return true;
    }
    return false;
}
function getNodeAutoInstrumentations(inputConfigs = {}) {
    checkManuallyProvidedInstrumentationNames(Object.keys(inputConfigs));
    const enabledInstrumentationsFromEnv = getEnabledInstrumentationsFromEnv();
    const disabledInstrumentationsFromEnv = getDisabledInstrumentationsFromEnv();
    const instrumentations = [];
    for (const name of Object.keys(InstrumentationMap)) {
        const Instance = InstrumentationMap[name];
        // Defaults are defined by the instrumentation itself
        const userConfig = inputConfigs[name] ?? {};
        const shouldDisable = shouldDisableInstrumentation(name, userConfig, enabledInstrumentationsFromEnv, disabledInstrumentationsFromEnv);
        if (shouldDisable) {
            continue;
        }
        try {
            api_1.diag.debug(`Loading instrumentation for ${name}`);
            instrumentations.push(new Instance(userConfig));
        }
        catch (e) {
            api_1.diag.error(e);
        }
    }
    return instrumentations;
}
exports.getNodeAutoInstrumentations = getNodeAutoInstrumentations;
function checkManuallyProvidedInstrumentationNames(manuallyProvidedInstrumentationNames) {
    for (const name of manuallyProvidedInstrumentationNames) {
        if (!Object.prototype.hasOwnProperty.call(InstrumentationMap, name)) {
            api_1.diag.error(`Provided instrumentation name "${name}" not found`);
        }
    }
}
function getInstrumentationsFromEnv(envVar) {
    const envVarValue = process.env[envVar];
    if (envVarValue == null) {
        return [];
    }
    const instrumentationsFromEnv = envVarValue
        ?.split(',')
        .map(instrumentationPkgSuffix => `@opentelemetry/instrumentation-${instrumentationPkgSuffix.trim()}`);
    checkManuallyProvidedInstrumentationNames(instrumentationsFromEnv);
    return instrumentationsFromEnv;
}
/**
 * Returns the list of instrumentations that are enabled based on the environment variable.
 * If the environment variable is unset, returns all instrumentation that are enabled by default.
 */
function getEnabledInstrumentationsFromEnv() {
    if (!process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS) {
        // all keys in the InstrumentationMap except for everything that is not enabled by default.
        return Object.keys(InstrumentationMap).filter(key => !defaultExcludedInstrumentations.includes(key));
    }
    const instrumentationsFromEnv = getInstrumentationsFromEnv('OTEL_NODE_ENABLED_INSTRUMENTATIONS');
    return instrumentationsFromEnv;
}
/**
 * Returns the list of instrumentations that are disabled based on the environment variable.
 */
function getDisabledInstrumentationsFromEnv() {
    if (!process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS) {
        return [];
    }
    const instrumentationsFromEnv = getInstrumentationsFromEnv('OTEL_NODE_DISABLED_INSTRUMENTATIONS');
    return instrumentationsFromEnv;
}
