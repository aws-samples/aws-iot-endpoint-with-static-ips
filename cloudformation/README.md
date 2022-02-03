# CloudFormation Stack for IoT Endpoints with static IPs

This CloudFormation Stack creates the architecture for static IP addresses on IoT endpoints.

## Useful commands

* `aws cloudformation create-stack` creates a new stack from a template
* `aws cloudformation update-stack` updates an existing stack with new changes
* `aws cloudformation delete-stack` deletes a stack and all it's resources

## Parameters

You need to pass the following parameters:

```shell
aws s3 cp iot-endpoint-static-ips.yaml s3://SOME_BUCKET
aws cloudformation create-stack \
  --stack-name iot-endpoint-static-ips \
  --template-url https://SOME_BUCKET.s3.amazonaws.com/iot-endpoint-static-ips.yaml \
  --capabilities CAPABILITY_IAM \
  --parameters \
    ParameterKey=DomainName,ParameterValue=iot.example.com \
    ParameterKey=Route53HostedZoneId,ParameterValue=ABCD1234 \
    ParameterKey=CertificateArn,ParameterValue= \
```

The Route 53 hosted zone needs to be responsible for the supplied domain.

If `CertificateArn` is left blank, a new certificate will be created with ACM.
