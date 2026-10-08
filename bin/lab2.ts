#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { HighDemandStack } from '../lib/high-demand-stack';

const app = new cdk.App();
new HighDemandStack(app, 'HighDemandStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: 'SBG: app web tolerante a fallos con ALB + Auto Scaling en 2 AZs',
});
