import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { HighDemandStack } from '../lib/high-demand-stack';

const template = Template.fromStack(new HighDemandStack(new cdk.App(), 'TestStack'));

test('VPC con subnets públicas en 2 AZs y sin NAT', () => {
  template.resourceCountIs('AWS::EC2::Subnet', 2);
  template.resourcePropertiesCountIs('AWS::EC2::Subnet', { MapPublicIpOnLaunch: true }, 2);
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
});

test('ASG con mínimo 2 y máximo 6 instancias, y health check del ELB', () => {
  template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    MinSize: '2',
    MaxSize: '6',
    HealthCheckType: 'ELB',
  });
});

test('ALB público con listener en el puerto 80', () => {
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 80 });
});

test('Las instancias solo aceptan tráfico desde el SG del ALB', () => {
  const instanceSgId = Object.keys(
    template.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: 'EC2: solo HTTP desde el ALB' },
    }),
  )[0];
  const albSgId = Object.keys(
    template.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: 'ALB: HTTP/HTTPS desde internet' },
    }),
  )[0];

  // Ninguna regla de entrada inline abierta a internet en el SG de las instancias.
  const instanceSg = template.toJSON().Resources[instanceSgId];
  expect(instanceSg.Properties.SecurityGroupIngress ?? []).toHaveLength(0);

  // Todas las reglas de entrada hacia las instancias vienen del SG del ALB.
  const ingress = template.findResources('AWS::EC2::SecurityGroupIngress', {
    Properties: { GroupId: { 'Fn::GetAtt': [instanceSgId, 'GroupId'] } },
  });
  expect(Object.keys(ingress).length).toBeGreaterThan(0);
  for (const rule of Object.values(ingress)) {
    expect(rule.Properties.SourceSecurityGroupId).toEqual({ 'Fn::GetAtt': [albSgId, 'GroupId'] });
    expect(rule.Properties.CidrIp).toBeUndefined();
  }
});

test('Volumen EBS de datos gp3 cifrado y borrado con la instancia', () => {
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: Match.objectLike({
      BlockDeviceMappings: [
        Match.objectLike({
          DeviceName: '/dev/sdb',
          Ebs: Match.objectLike({ VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true }),
        }),
      ],
      MetadataOptions: { HttpTokens: 'required' },
      Monitoring: { Enabled: true },
    }),
  });
});

test('Rol IAM de las instancias solo con la política de SSM', () => {
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: [Match.objectLike({ Principal: { Service: 'ec2.amazonaws.com' } })],
    }),
    ManagedPolicyArns: [
      { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AmazonSSMManagedInstanceCore']] },
    ],
  });
  template.resourceCountIs('AWS::IAM::Policy', 0);
});

test('Escalado por CPU al 60% y alarmas de CloudWatch', () => {
  template.hasResourceProperties('AWS::AutoScaling::ScalingPolicy', {
    PolicyType: 'TargetTrackingScaling',
    TargetTrackingConfiguration: Match.objectLike({
      PredefinedMetricSpecification: { PredefinedMetricType: 'ASGAverageCPUUtilization' },
      TargetValue: 60,
    }),
  });
  template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
});
