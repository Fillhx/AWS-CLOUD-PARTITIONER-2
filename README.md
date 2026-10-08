# LAB2 — App web de alta demanda (SBG) con AWS CDK

Aplicación web con nginx en EC2, detrás de un ALB, con Auto Scaling (2–6 instancias) en 2 Availability Zones. Toda la infraestructura está en `lib/high-demand-stack.ts`.

## Arquitectura

| Pieza | Cómo está resuelta |
|---|---|
| VPC | 2 AZs, solo subnets públicas, **sin NAT Gateway** (ahorra ~32 USD/mes) |
| EC2 | t3.micro, Amazon Linux 2023, nginx; la página muestra el ID de la instancia y su AZ |
| EBS | Disco de datos gp3 de 8 GB cifrado (`/dev/sdb` → `/data`); nginx sirve desde `/data/www` |
| ALB | Público, puerto 80, health check en `/health` cada 10 s |
| Auto Scaling | min 2 / max 6, health check del ELB (reemplaza instancias no sanas) |
| Security Groups | ALB: 80/443 desde internet. EC2: **solo** puerto 80 desde el SG del ALB, sin SSH |
| IAM | Rol con solo `AmazonSSMManagedInstanceCore` (acceso por Session Manager, sin llaves) |
| Boss Fight | Target tracking por CPU al 60 %, monitoreo detallado (métricas cada 1 min), 4 alarmas de CloudWatch y un dashboard |

**¿Por qué subnets públicas si las instancias no deben ser accesibles?** Las instancias tienen IP pública para salir a internet (instalar nginx) sin pagar NAT, pero el Security Group no deja entrar nada que no venga del ALB. En producción se usarían subnets privadas con NAT o VPC endpoints.

**Sobre la persistencia en EBS:** cada instancia tiene su propio volumen, que se borra al terminarla (`deleteOnTermination`), para no dejar volúmenes huérfanos cuando el ASG escala hacia adentro o al hacer `cdk destroy`. Si hiciera falta compartir datos entre instancias, lo correcto sería EFS, S3 o una base de datos.

**Sobre el puerto 443:** el SG del ALB ya lo permite, pero el listener HTTPS necesita un certificado de ACM con un dominio propio. Por eso solo está el listener en el puerto 80.

## Despliegue

```bash
aws login                      # o aws sso login / aws configure
npm install
npm test                       # 7 pruebas de los requisitos sobre la plantilla
npx cdk bootstrap              # solo la primera vez por cuenta/región
npx cdk deploy
```

Las salidas del stack incluyen `AlbUrl`, `AsgName` y `DashboardUrl`.

## Verificar los criterios de éxito

```bash
URL=$(aws cloudformation describe-stacks --stack-name HighDemandStack \
  --query "Stacks[0].Outputs[?OutputKey=='AlbUrl'].OutputValue" --output text)
ASG=$(aws cloudformation describe-stacks --stack-name HighDemandStack \
  --query "Stacks[0].Outputs[?OutputKey=='AsgName'].OutputValue" --output text)

# 1. El ALB responde y reparte entre instancias/AZs
for i in $(seq 1 10); do curl -s $URL | grep -o 'i-[0-9a-f]*.*code>'; done

# 2. Health checks en verde
TG=$(aws elbv2 describe-target-groups --query "TargetGroups[?contains(TargetGroupName,'HighDe')].TargetGroupArn" --output text)
aws elbv2 describe-target-health --target-group-arn $TG \
  --query "TargetHealthDescriptions[].[Target.Id,TargetHealth.State]" --output table

# 3. Acceso directo a una EC2 bloqueado (debe agotar el tiempo de espera)
IP=$(aws ec2 describe-instances --filters "Name=tag:aws:autoscaling:groupName,Values=$ASG" \
  "Name=instance-state-name,Values=running" --query "Reservations[0].Instances[0].PublicIpAddress" --output text)
curl -m 5 http://$IP || echo "Bloqueado: OK"

# 4. Tolerancia a fallos: en una terminal deja corriendo peticiones…
while true; do curl -s -o /dev/null -w "%{http_code}\n" $URL; sleep 0.5; done
# …y en otra termina una instancia: deben seguir saliendo 200 y el ASG lanza su reemplazo
aws ec2 terminate-instances --instance-ids <id>
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names $ASG \
  --query "AutoScalingGroups[0].Instances[].[InstanceId,AvailabilityZone,LifecycleState]" --output table
```

## Boss Fight: tráfico 10x

La página es estática, así que el tráfico HTTP casi no sube la CPU de una t3.micro. Para provocar el escalado de forma confiable, sube la CPU con `stress-ng` (ya instalado) a través de Session Manager:

```bash
aws ssm send-command --document-name AWS-RunShellScript \
  --targets "Key=tag:aws:autoscaling:groupName,Values=$ASG" \
  --parameters 'commands=["stress-ng --cpu 0 --cpu-load 90 --timeout 15m &"]'
```

Además, genera tráfico real contra el ALB, por ejemplo con [hey](https://github.com/rakyll/hey): `hey -z 10m -c 200 $URL` (con `ab`, usa `-r` para que un timeout no aborte la prueba).

> **Importante:** el launch template activa `detailedMonitoring`. Sin esto, EC2 publica la CPU cada 5 minutos, las alarmas de 1 minuto del target tracking ven "no datapoints" y el ASG no escala. Así pasó en la primera prueba.

**Resultado de la prueba (2026-10-08):** con la CPU al 88 %, el ASG pasó de 2 a 3 instancias y luego a 5, sin intervención y en unos 4 minutos desde que llegaron las métricas. Se detuvo en 5 porque con 5 instancias el promedio ya bajaba al 58 %. El ALB no devolvió ningún 5xx y la latencia p95 de las instancias se mantuvo por debajo de 3 ms.

En el dashboard (`DashboardUrl`) vas a ver la CPU pasar del 60 %, la alarma `HighCpuAlarm` en ALARM y las instancias en servicio subir solas hasta 6. Cuando pare la carga, el ASG vuelve a 2 (escalar hacia adentro tarda unos 15 minutos, porque target tracking es conservador).

**¿Es el ALB el cuello de botella?** El ALB escala solo. Las señales de que se está quedando corto son las alarmas `Alb5xxAlarm` (5xx generados por el propio ALB, no por las instancias) y `HighLatencyAlarm`, junto con la gráfica de peticiones. Si la latencia sube mientras la CPU de las instancias está baja, el problema no está en EC2.

## Limpieza

```bash
npx cdk destroy
```

Los volúmenes EBS se borran con sus instancias. Aun así, revisa en la consola (EC2 → Volúmenes, filtrando por `available`) que no quede ninguno huérfano.
