'use strict';

import randomstring from 'randomstring';
import chalk from 'chalk';
import fs from 'fs';
import https from 'https';

class CloudfrontInvalidation {

    constructor(serverless, options) {
        this.serverless = serverless;
        this.options = options || {};
        this.provider = 'aws';
        this.aws = this.serverless.getProvider('aws');

        if (this.options.cacert) {
            this.handleCaCert(this.options.cacert);
        }

        this.commands = {
            cloudfrontInvalidation: {
                usage: "Invalidate Cloudfront Cache",
                lifecycleEvents: [
                    'invalidate'
                ]
            }
        };

        this.hooks = {
            'cloudfrontInvalidation:invalidate': this.invalidate.bind(this),
            'after:deploy:deploy': this.afterDeploy.bind(this),
        };
    }

    handleCaCert(caCert) {
        const cli = this.serverless.cli;

        if (!fs.existsSync(caCert)) {
            throw new Error("Supplied cacert option to a file that does not exist: " + caCert);
        }

        this.aws.sdk.config.update({
            httpOptions: { agent: new https.Agent({ ca: fs.readFileSync(caCert) }) }
        });

        cli.consoleLog(`CloudfrontInvalidation: ${chalk.yellow('ca cert handling enabled')}`);
    }

    createInvalidation(distributionId, reference, cloudfrontInvalidation) {
        const cli = this.serverless.cli;
        const cloudfrontInvalidationItems = cloudfrontInvalidation.items;

        const params = {
            DistributionId: distributionId, /* required */
            InvalidationBatch: { /* required */
                CallerReference: reference, /* required */
                Paths: { /* required */
                    Quantity: cloudfrontInvalidationItems.length, /* required */
                    Items: cloudfrontInvalidationItems
                }
            }
        };
        return this.aws.request('CloudFront', 'createInvalidation', params).then(
            () => {
                cli.consoleLog(`CloudfrontInvalidation: ${chalk.yellow('Invalidation started')}`);
            },
            err => {
                cli.consoleLog(JSON.stringify(err));
                cli.consoleLog(`CloudfrontInvalidation: ${chalk.yellow('Invalidation failed')}`);
                throw err;
            }
        );
    }

    invalidateElements(elements) {
        const cli = this.serverless.cli;

        if (this.options.noDeploy) {
            cli.consoleLog('skipping invalidation due to noDeploy option');
            return;
        }

        const invalidationPromises = elements.map(element => {
            let cloudfrontInvalidation = element;
            let reference = randomstring.generate(16);
            let distributionId = cloudfrontInvalidation.distributionId;
            let stage = cloudfrontInvalidation.stage;

            if (stage !== undefined && stage !== `${this.serverless.service.provider.stage}`) {
                return;
            }

            if (distributionId) {
                cli.consoleLog(`DistributionId: ${chalk.yellow(distributionId)}`);

                return this.createInvalidation(distributionId, reference, cloudfrontInvalidation);
            }

            if (!cloudfrontInvalidation.distributionIdKey) {
                cli.consoleLog('distributionId or distributionIdKey is required');
                return;
            }

            cli.consoleLog(`DistributionIdKey: ${chalk.yellow(cloudfrontInvalidation.distributionIdKey)}`);

            // get the id from the output of stack.
            const stackName = this.serverless.getProvider('aws').naming.getStackName()

            return this.aws.request('CloudFormation', 'describeStacks', { StackName: stackName })
                .then(result => {
                    if (result) {
                        const outputs = result.Stacks[0].Outputs;
                        outputs.forEach(output => {
                            if (output.OutputKey === cloudfrontInvalidation.distributionIdKey) {
                                distributionId = output.OutputValue;
                            }
                        });
                    }
                })
                .then(() => this.createInvalidation(distributionId, reference, cloudfrontInvalidation))
                .catch(() => {
                    cli.consoleLog('Failed to get DistributionId from stack output. Please check your serverless template.');
                });
        });

        return Promise.all(invalidationPromises);
    }

    afterDeploy() {
        const elementsToInvalidate = this.serverless.service.custom.cloudfrontInvalidation
            .filter((element) => {
                if (element.autoInvalidate !== false) {
                    return true;
                }

                this.serverless.cli.consoleLog(`Will skip invalidation for the distributionId "${element.distributionId || element.distributionIdKey}" as autoInvalidate is set to false.`);
                return false;
            });

        return this.invalidateElements(elementsToInvalidate);
    }

    invalidate() {
        return this.invalidateElements(this.serverless.service.custom.cloudfrontInvalidation);
    }
}

module.exports = CloudfrontInvalidation;
