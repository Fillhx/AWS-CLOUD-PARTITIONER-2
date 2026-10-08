import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

// Disco EBS de datos: se adjunta como /dev/sdb y se monta en DATA_DIR.
const DATA_DEVICE = '/dev/sdb';
const DATA_DIR = '/data';
const CPU_TARGET_PERCENT = 60;

export class HighDemandStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- VPC: solo subnets públicas en 2 AZs, sin NAT Gateway (no hace falta y cuesta) ---
    const vpc = new ec2.Vpc(this, 'AppVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    // --- Security Groups ---
    // El ALB es lo único expuesto a internet.
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB: HTTP/HTTPS desde internet',
      allowAllOutbound: false,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP desde internet');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS desde internet');

    // Las instancias solo aceptan tráfico del ALB (sin SSH: se entra por Session Manager).
    // La salida queda abierta para instalar paquetes y hablar con SSM.
    const instanceSg = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'EC2: solo HTTP desde el ALB',
      allowAllOutbound: true,
    });
    instanceSg.addIngressRule(albSg, ec2.Port.tcp(80), 'HTTP solo desde el ALB');
    albSg.addEgressRule(instanceSg, ec2.Port.tcp(80), 'ALB hacia las instancias');

    // --- IAM: mínimo privilegio. Solo Session Manager (sin llaves SSH ni puerto 22) ---
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Rol de las instancias web: solo administracion por SSM',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });

    // --- User data: monta el EBS de datos e instala nginx con una página que muestra la instancia/AZ ---
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y nginx stress-ng',

      // En instancias Nitro el disco aparece como NVMe; amazon-ec2-utils crea el enlace /dev/sdb.
      `for i in $(seq 1 30); do [ -e ${DATA_DEVICE} ] && break; sleep 2; done`,
      `DEV=$(readlink -f ${DATA_DEVICE})`,
      'blkid "$DEV" || mkfs -t xfs "$DEV"',
      `mkdir -p ${DATA_DIR}`,
      `UUID=$(blkid -s UUID -o value "$DEV")`,
      `grep -q "$UUID" /etc/fstab || echo "UUID=$UUID ${DATA_DIR} xfs defaults,nofail 0 2" >> /etc/fstab`,
      'mount -a',

      // Contenido de la app en el volumen EBS.
      'TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300")',
      'md() { curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/$1"; }',
      'INSTANCE_ID=$(md instance-id)',
      'AZ=$(md placement/availability-zone)',
      `mkdir -p ${DATA_DIR}/www`,
      `cat > ${DATA_DIR}/www/index.html <<EOF`,
      '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>SBG - Evento</title>',
      '<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}code{background:#eee;padding:.1rem .3rem}</style>',
      '</head><body><h1>Grupo SBG &middot; Evento de alto tr&aacute;fico</h1>',
      '<p>Atendido por la instancia <code>$INSTANCE_ID</code> en <code>$AZ</code>.</p>',
      '<p>Recarga la p&aacute;gina: el ALB reparte las peticiones entre instancias y zonas.</p>',
      '</body></html>',
      'EOF',
      `echo ok > ${DATA_DIR}/www/health`,
      `chown -R nginx:nginx ${DATA_DIR}/www`,
      `chcon -R -t httpd_sys_content_t ${DATA_DIR}/www || true`,

      `sed -i 's#root\\s\\+/usr/share/nginx/html;#root ${DATA_DIR}/www;#' /etc/nginx/nginx.conf`,
      'systemctl enable --now nginx',
    );

    // --- Auto Scaling Group: 2 a 6 instancias repartidas en las 2 AZs ---
    const launchTemplate = new ec2.LaunchTemplate(this, 'AppLaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: instanceSg,
      role,
      userData,
      requireImdsv2: true,
      // Métricas cada 1 min: sin esto la CPU llega cada 5 min y las alarmas de 1 min del escalado nunca se disparan.
      detailedMonitoring: true,
      associatePublicIpAddress: true, // Necesaria para salir a internet sin NAT; el SG bloquea la entrada.
      blockDevices: [
        {
          deviceName: DATA_DEVICE,
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            // Se borra con la instancia: evita volúmenes huérfanos al escalar hacia adentro o al hacer cdk destroy.
            deleteOnTermination: true,
          }),
        },
      ],
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'AppASG', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate,
      minCapacity: 2,
      maxCapacity: 6,
      // Reemplaza también las instancias que el ALB marque como no sanas, no solo las caídas.
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
        gracePeriod: cdk.Duration.minutes(3),
      }),
      defaultInstanceWarmup: cdk.Duration.minutes(2),
      groupMetrics: [autoscaling.GroupMetrics.all()],
    });

    // --- ALB ---
    const alb = new elbv2.ApplicationLoadBalancer(this, 'AppALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener('Http', { port: 80, open: false });
    const targetGroup = listener.addTargets('AppTargets', {
      port: 80,
      targets: [asg],
      // Chequeo agresivo: una instancia terminada a mano sale del balanceo en ~10 s (2 fallos x 5 s).
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(3),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      // Saca rápido del balanceo a una instancia que se está terminando.
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // --- Boss Fight: escalado por CPU (target tracking al 60%) ---
    asg.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: CPU_TARGET_PERCENT,
    });

    // --- CloudWatch: alarmas y dashboard para seguir el evento ---
    const cpuMetric = new cloudwatch.Metric({
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });
    const inServiceMetric = new cloudwatch.Metric({
      namespace: 'AWS/AutoScaling',
      metricName: 'GroupInServiceInstances',
      dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });
    const requestsMetric = alb.metrics.requestCount({ period: cdk.Duration.minutes(1) });
    const latencyMetric = alb.metrics.targetResponseTime({
      period: cdk.Duration.minutes(1),
      statistic: 'p95',
    });
    const alb5xxMetric = alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
      period: cdk.Duration.minutes(1),
    });
    const unhealthyMetric = targetGroup.metrics.unhealthyHostCount({ period: cdk.Duration.minutes(1) });

    new cloudwatch.Alarm(this, 'HighCpuAlarm', {
      alarmDescription: `CPU promedio del ASG por encima de ${CPU_TARGET_PERCENT}%`,
      metric: cpuMetric,
      threshold: CPU_TARGET_PERCENT,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'UnhealthyHostsAlarm', {
      alarmDescription: 'Hay instancias no sanas detrás del ALB',
      metric: unhealthyMetric,
      threshold: 0,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // Errores 5xx generados por el propio ALB: señal de que el balanceador es el cuello de botella.
    new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      alarmDescription: 'El ALB está devolviendo errores 5xx propios',
      metric: alb5xxMetric,
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'HighLatencyAlarm', {
      alarmDescription: 'Latencia p95 de las instancias por encima de 1 s',
      metric: latencyMetric,
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const dashboard = new cloudwatch.Dashboard(this, 'EventDashboard', {
      dashboardName: `${this.stackName}-evento`,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'CPU promedio del ASG (%)',
        left: [cpuMetric],
        leftAnnotations: [{ value: CPU_TARGET_PERCENT, label: 'Objetivo' }],
      }),
      new cloudwatch.GraphWidget({ title: 'Instancias en servicio', left: [inServiceMetric] }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Peticiones al ALB', left: [requestsMetric] }),
      new cloudwatch.GraphWidget({
        title: 'Latencia p95 (s) y 5xx del ALB',
        left: [latencyMetric],
        right: [alb5xxMetric],
      }),
      new cloudwatch.GraphWidget({ title: 'Instancias no sanas', left: [unhealthyMetric] }),
    );

    // --- Salidas ---
    new cdk.CfnOutput(this, 'AlbUrl', { value: `http://${alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'AsgName', { value: asg.autoScalingGroupName });
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`,
    });
  }
}
