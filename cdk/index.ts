import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elb_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';

export class IoTEndpointStaticIPs extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainName = new cdk.CfnParameter(this, 'DomainName', {
      type: 'String',
      description: 'Domain name to use for the new IoT Endpoint with static IPs, without final dot.'
    });
    const r53zoneId = new cdk.CfnParameter(this, 'Route53HostedZoneId', {
      type: 'String',
      description: 'Route53 HostedZoneId to create a new DNS record in.'
    });
    const certificateArn = new cdk.CfnParameter(this, 'CertificateArn', {
      type: 'String',
      description: 'The ARN of the certificate to use for the new IoT Endpoint. Leave empty to auto-create.'
    });

    // ########################################################################

    const certificateCondition = new cdk.CfnCondition(this, 'CreateCertificate', {
      expression: cdk.Fn.conditionEquals(certificateArn, '')
    });

    // ########################################################################
    // # Basic network resources with VPC, Subnets, Route Tables, etc.

    const vpc = new ec2.Vpc(this, 'VPC', {
      natGateways: 0,
      cidr: '10.10.10.0/24',
      maxAzs: 2,
      subnetConfiguration: [{
        name: 'iotendpoint-nlb',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: 28,
      },
      {
        name: 'iotendpoint-vpce',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        cidrMask: 28,
      }]
    });

    // ########################################################################
    // # IoT Domain Configuration and custom domain, certificate

    const r53zone = route53.HostedZone.fromHostedZoneId(this, 'ImportedZone', r53zoneId.valueAsString);

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: domainName.valueAsString,
      validation: acm.CertificateValidation.fromDns(r53zone),
    });
    const cfnCertificate = certificate.node.defaultChild as acm.CfnCertificate;
    cfnCertificate.cfnOptions.condition = certificateCondition;

    new iot.CfnDomainConfiguration(this, 'IoTDomainConfiguration', {
      domainConfigurationName: 'StaticIPs-VPC-Endpoint-standalone-2',
      domainName: domainName.valueAsString,
      serverCertificateArns: [cdk.Fn.conditionIf(certificateCondition.logicalId, certificate.certificateArn, certificateArn.valueAsString).toString()]
    });

    // ########################################################################
    // VPC Endpoint and Lambda-based custom resource to get private IP addresses

    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: vpc,
      description: 'Allow IoT Endpoint access from anywhere',
      allowAllOutbound: false,
    });

    const subnetSelection: ec2.SubnetSelection = {
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED
    };
    const vpce = new ec2.InterfaceVpcEndpoint(this, 'IoTVPCEndpointSecurityGroup', {
      vpc: vpc,
      service: new ec2.InterfaceVpcEndpointAwsService('iot.data'),
      subnets: subnetSelection,
      securityGroups: [securityGroup],
      privateDnsEnabled: false,
    })

    const crRole = new iam.Role(this, 'VPCEndpointIPsLambdaRole', {
      roleName: 'VPCEndpointIPsLambdaRole',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        'VPCEndpointIPsLambdaPolicy': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'ec2:DescribeNetworkInterfaces',
                'ec2:DescribeNetworkInterfaceAttribute',
              ],
              resources: ['*'] // we need to list all ENIs to retrieve the associated private IP addresses
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              resources: [cdk.Fn.sub('arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${AWS::StackName}-*')]
            })
          ]
        })
      }
    });

    const crFunction = new lambda.CfnFunction(this, 'VPCEndpointIPsLambdaFunction', {
      handler: 'index.lambda_handler',
      runtime: 'python3.9',
      timeout: 10,
      role: crRole.roleArn,
      code: {
        zipFile: `
import cfnresponse
import boto3
import json
def lambda_handler(event, context):
    print('REQUEST RECEIVED:\\n' + json.dumps(event))
    responseStatus = cfnresponse.FAILED
    responseData = {}
    if 'RequestType' not in event:
        responseData = {'error': 'RequestType not in event'}
    elif event['RequestType'] == 'Delete':
        responseStatus = cfnresponse.SUCCESS
    elif event['RequestType'] in ['Create', 'Update']:
        try:
            responseData['IPs'] = []
            ec2 = boto3.resource('ec2')
            eni_ids = event['ResourceProperties']['NetworkInterfaceIds']
            for eni_id in eni_ids:
                eni = ec2.NetworkInterface(eni_id)
                responseData['IPs'].append(eni.private_ip_address)
            responseStatus = cfnresponse.SUCCESS
        except Exception as e:
            responseData = {'error': str(e)}
    cfnresponse.send(event, context, responseStatus, responseData)
    `}
    });

    const crIoTEndpointIps = new cdk.CustomResource(this, 'IoTVPCEndpointIPs', {
      serviceToken: crFunction.attrArn,
      properties: {
        NetworkInterfaceIds: vpce.vpcEndpointNetworkInterfaceIds,
      }
    });

    // ########################################################################
    // # Network Load Balancer, Listeners, andd Target Groups

    const eip1 = new ec2.CfnEIP(this, 'ElasticIP1', {
      domain: 'vpc',
    });
    eip1.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const eip2 = new ec2.CfnEIP(this, 'ElasticIP2', {
      domain: 'vpc',
    });
    eip2.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const nlb = new elb.NetworkLoadBalancer(this, 'NLB', {
      vpc: vpc,
      internetFacing: true,
    });
    const cfnNlb = nlb.node.defaultChild as elb.CfnLoadBalancer;
    cfnNlb.subnets = [];
    cfnNlb.subnetMappings = [
      { subnetId: vpc.publicSubnets[0].subnetId, allocationId: eip1.attrAllocationId },
      { subnetId: vpc.publicSubnets[1].subnetId, allocationId: eip2.attrAllocationId },
    ];

    const listeners: [number, string][] = [[443, 'HTTPS'], [8443, 'ALT-HTTPS'], [8883, 'MQTTS']]
    for (const [port, protocolName] of listeners) {

      // NLB does not support security groups, so allow ingress and egress traffic from anywhere (0.0.0.0/0)
      securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(port), `Allow ${protocolName} access from anywhere`)
      securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(port), `Allow ${protocolName} access to anywhere`)

      nlb.addListener('Listener-' + protocolName, {
        port: port,
        protocol: elb.Protocol.TCP,
        defaultTargetGroups: [
          new elb.NetworkTargetGroup(this, 'TargetGroup-' + protocolName, {
            vpc: vpc,
            port: port,
            protocol: elb.Protocol.TCP,
            targetType: elb.TargetType.IP,
            targets: [
              new elb_targets.IpTarget(cdk.Fn.select(0, crIoTEndpointIps.getAtt('IPs').toString() as unknown as string[])),
              new elb_targets.IpTarget(cdk.Fn.select(1, crIoTEndpointIps.getAtt('IPs').toString() as unknown as string[])),
            ],
            // stickiness not supported yet, see https://github.com/aws/aws-cdk/issues/10198
          })
        ]
      });
    }

    new route53.ARecord(this, 'DNSRecord', {
      recordName: `${domainName.valueAsString}.`,
      zone: r53zone,
      target: route53.RecordTarget.fromAlias(new route53_targets.LoadBalancerTarget(nlb))
    });

    // ########################################################################

    new cdk.CfnOutput(this, 'OutputElasticIP1', {
      value: eip1.ref,
      description: "Static IP address for IoT Endpoint at the new domain."
    })

    new cdk.CfnOutput(this, 'OutputElasticIP2', {
      value: eip2.ref,
      description: "Static IP address for IoT Endpoint at the new domain."
    })
  }
}

const app = new cdk.App();
new IoTEndpointStaticIPs(app, 'IoTEndpointStaticIPs');
app.synth();
