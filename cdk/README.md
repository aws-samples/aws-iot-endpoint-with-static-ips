# CDK App for IoT Endpoints with static IPs

This CDK app creates the architecture for static IP addresses on IoT endpoints.

## Useful commands

* `cdk deploy` deploys this stack to your default AWS account/region
* `cdk diff` compares the deployed stack with current state
* `cdk synth` emits the synthesized CloudFormation template
* `cdk destroy` deletes a stack and all it's resources

## Parameters

You need to pass the following commands and parameters:

```shell
npm install
npx cdk bootstrap
npx cdk deploy \
  --parameters DomainName=iot.example.com \
  --parameters Route53HostedZoneId=ABCD1234 \
  --parameters CertificateArn=
```

The Route 53 hosted zone needs to be responsible for the supplied domain.

If `CertificateArn` is left blank, a new certificate will be created with ACM.
