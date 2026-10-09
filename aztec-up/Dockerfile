########################################################################################################################
# A minimal ubuntu setup. Used for testing releases.
FROM aztecprotocol/aztec-up-test-base
COPY --chown=1000:1000 verdaccio-storage /home/ubuntu/verdaccio-storage
COPY --chown=1000:1000 bin/0.0.1/packages.tar.gz /home/ubuntu/packages.tar.gz
RUN touch /aztec_release_test_container
