var $ = require('jQuery');
window.forge = require('node-forge')();
var connectSDK = require('connectsdk.session');
var Handlebars = require('handlebars');
require('jquery-validation');
require('bootstrap');

require('./validate-defaults');
require('./paymentitem-non-cards-helpers');
require('./paymentitem-formatter');

$(function () {
    function _showPaymentItem(id) {
        $("#loading").show();
        session.getPaymentProduct(id, paymentDetails).then(function (paymentProduct) {
            $("#loading").hide();
            paymentRequest.setPaymentProduct(paymentProduct);

            var accountOnFile = null;
            if (accountOnFile) {
                paymentRequest.setAccountOnFile(accountOnFile);
            }

            if (paymentProduct.paymentProductFields.length === 0) {
                encrypt();
            } else {
                _renderPage(paymentProduct, $("#detail-template").html(), accountOnFile, false);
            }
        }, function () {
            $("#loading").hide();
            $("#error").fadeIn();
        });
    };

    function _renderPage(paymentItem, source, accountOnFile, isGroup) {
        var template = Handlebars.compile(source);
        var json = paymentItem.json;

        // We now add some additional stuff to the JSON object that represents the selected payment product so handlebars
        // can actually fill out all the variables in its template. Some of these values for these variables are not
        // available in the core payment product info so we add them.
        $.each(json.fields, function (index, field) {
            // A) a isCurrency field because the #if Handlebars clause it too limited (it cannot do the === 'currency' check itself)
            if (field.displayHints.formElement.type === "currency") {
                field.displayHints.formElement.isCurrency = true;
            }

            // B) The paymentDetails so we can use its data in the field renderer; useful for printing currency etc.
            field.paymentContext = paymentDetails;

            // C) In the case we have an account on file (AOF) we need to display the known values that
            // are defined for the fields that the AOF contains. We're adding these values to the fields
            if (accountOnFile) {
                var relatedAofField = accountOnFile.attributeByKey[field.id];
                if (relatedAofField) {
                    // Nice, the account on file has an existing value for this field. To signal to the handlebars template
                    // that this is the case we add a new field field.aofData that contains that known value. However: we want
                    // to apply a mask to the known value before we show it. To do that we first retrieve the paymentProductField
                    // SDK object because it has the applyMask method. Note that we should not use the getMaskedValueByAttributeKey
                    // method on the AccountOnFile object because that uses the masking info that is provided in the
                    // AccountOnFile displayHints object. That object is used to indicate which AoF fields should be shown
                    // in the payment product selection list by including only the masks for those fields. In our case we want
                    // to mask all known fields, so we fall back to the mask information in the paymentProductField object.
                    var paymentProductField = paymentItem.paymentProductFieldById[field.id];
                    field.knownValue = paymentProductField.applyWildcardMask(relatedAofField.value).formattedValue;

                    // We also determine if this field should be readonly. This depends on the status of the field
                    // as defined in the Account On File object. If the status is READ_ONLY it cannot be changed, but
                    // if the value is CAN_WRITE or even MUST_WRITE it's existing value can be overwritten.
                    field.isReadOnly = !relatedAofField.status || relatedAofField.status === 'READ_ONLY';
                }
            }

            // D) Fields that are part of the aofData and that have the READ_ONLY status should be excluded from the
            //    encrypted blob.
            field.includeInEncryptedBlob = field.isReadOnly === undefined || field.isReadOnly ? "false" : "true";

            // E) indicate that this field is the cardnumber field to render the holder for the cobrands feature
            if (field.id === "cardNumber") {
                field.isCardNumberField = true;
            }
        });

        // E) There's one field that we should add to the form that is not included in the payment product fields list for
        // a payment product: the "remember me" option, aka : tokenization. It's only visible if the payment product
        // itself allows it: allowsTokenization === true && autoTokenized === false.  (If autoTokenized === true it will
        // get tokenized automatically by the server and we do not need to show the checkbox).

        // for groups a different logic is in place: if the payment is recurring the checkbox should be shown.
        if (isGroup) {
            json.showRememberMe = paymentDetails.isRecurring;
        } else {
            json.showRememberMe = json.allowsTokenization === true && json.autoTokenized === false;
        }

        // We have extended the JSON object that represents the payment product so that it contains
        // all the necessary information to fill in the Handlebars template. Now we generate the
        // HTML and add it to the DOM.
        $("#handlebarsDrop").html(template(json));
        if (!json.showRememberMe) {
            $("#rememberme").closest('.checkbox').hide();
        }

        // 2) Add validators to each of the fields in the form
        connect.addValidators(paymentItem);


        // 3) Add submit handling for when the user finishes filling out the form

        // After the customer is done filling out the form he submits it. But instead of sending the form to the server
        // we validate it and if successful we encrypt the result. Your application should send the cypher text to
        // your e-commerce server itself.
        $(".validatedForm").validate({
            submitHandler: function (e) {

                // We create an object with key:value pairs consisting on the id of the paymentproductfield
                // and its value as presented (with or without mask).
                var blob = {};

                // We only add the form elements that have the "data-includeInEncryptedBlob=true" attribute; which we've added
                // to each input/select when we created the form.
                $(".validatedForm [data-includeInEncryptedBlob=true]").each(function () {

                    if ($(this).attr("id").indexOf("-baseCurrencyUnit") !== -1 || $(this).attr("id").indexOf("-centecimalCurrencyUnit") !== -1) {
                        // The example application splits up currency fields into two fields: base currency and cents
                        // We need to merge the values of these two fields again because the SDK only accepts one
                        // value per field (and it expects the complete value in cents in this case)
                        var id = $(this).attr("id").substring(0, $(this).attr("id").indexOf("-"));
                        if ($(this).attr("id").indexOf("-baseCurrencyUnit") !== -1) {
                            blob[id] = (blob[id]) ? (Number(blob[id]) + Number($(this).val() * 100)) + '' : Number($(this).val() * 100) + '';
                        }
                        if ($(this).attr("id").indexOf("-centecimalCurrencyUnit") !== -1) {
                            blob[id] = (blob[id]) ? (Number(blob[id]) + Number($(this).val())) + '' : Number($(this).val()) + '';
                        }

                    } else {
                        // In all other cases just us ethe entered value
                        blob[$(this).attr("id")] = $(this).val();
                    }
                });

                // Remember that we need to add all entered values to paymentRequest so they will be included in the
                // encryption later on.
                for (var key in blob) {
                    paymentRequest.setValue(key, blob[key]);
                }

                // encrypt the paymentRequest
                encrypt();

                // Cancel submitting the form
                return false;
            }
        });


        // 4) Add handlers for some additional bells and whistles (such as tooltips, IIN lookups, etc)

        // A) Sometimes we show the "tokenize payment" checkbox (See above). Because of this special way of including the
        //    field we also need a separate handling of it. That is done here.
        $("#rememberme").on("change", function () {
            paymentRequest.setTokenize($(this).is(":checked"));
        });

        // B) Some fields have tooltips (e.g. the CVV code field). We initialize the popups that contain those tooltips here.
        $('.info-popover').popover();

        // C) We mask the fields that need masking as defined in the payment product field definition. Either use use a jquery masked
        //    input plugin, or write your own. In this example we use jquery formatter plugin, which is included in this file at the
        //    bottom.

        connect.updateFieldMask(paymentItem);

        // D) The creditcard field has an IIN lookup that determines the issuer of the card. It could be the case that the customer chose
        //    payment product VISA but entered a mastercard creditcard number. In that case the selected payment product should switch.
        $("#cardNumber").after('<span class="cc-image"></span>');
        $("#cardNumber").parent().find(".cc-image").html('<img src="' + paymentItem.displayHints.logo + '">').show();
        var currentFirst6Digits = '',
            storedFirst6Digits = '';
        $("#cardNumber").on("keyup", function (e) {
            if (e.keyCode === 17 || e.keyCode === 91) {
                // don't handle ctrl events (copy paste otherwise will send double iin details calls)
                return true;
            }
            // we only need to analyse the card's first 6 digits
            currentFirst6Digits = $(this).val().substring(0, 7);
            if (currentFirst6Digits !== storedFirst6Digits) {
                // We ue the SDK to do the IIN lookup, this is an async task that we provide you as a promise
                session.getIinDetails($(this).val(), paymentDetails).then(function (response) {
                    // The promise has fulfilled.
                    connect.hideCobranding();
                    // if this new creditcard is supported you can show the new logo in the helper element
                    if (response.status === "SUPPORTED") {
                        //Remove notAllowedInContext class so validator succeeds if there was a SUPPORTED_BUT_NOT_ALLOWED response before
                        setAllowedInContextStatus(true);
                        storedFirst6Digits = currentFirst6Digits;
                        // Fetch the paymentproduct that belongs to the id the IIN returned, this is an async task that we provide you as a promise
                        session.getPaymentProduct(response.paymentProductId, paymentDetails).then(function (paymentProduct) {
                            // The promise has fulfilled.
                            //update field Mask in case a different cardnumber is filled in
                            connect.updateFieldMask(paymentProduct);
                            // update the paymentproduct in the request
                            paymentRequest.setPaymentProduct(paymentProduct);
                            connect.updatePaymentProduct(paymentProduct);
                            connect.handleCobrands(paymentProduct, response, paymentRequest, session, paymentDetails);
                        });

                    } else if (response.status === "EXISTING_BUT_NOT_ALLOWED") {
                        // The creditcard number that the user provided did map on a supported (for this merchant) issuer.
                        // But the payment is not allowed with the current payment context. (countryCode, isRecurring, amount, currencyCode)
                        // We handle this by adding a method to the jquery validator who checks for the class 'notAllowedInContext'
                        setCardStatus(false, false, false);
                    } else {
                        // The creditcard number that the user provided did not map on any known or supported
                        // (for this merchant) issuer. We decide to not change the payment product and simply
                        // hide the payment poduct logo to indicate that it's unknown / unsupported.
                        setCardStatus(false, false, false);
                    }

                }, function (response) {
                    // The promise failed, inform the user what happened.
                    setCardStatus(false, false, false);
                });
            }
        });

        function setCardStatus(isAllowedInContext, showCobrand, showCCImage) {
            // set allowedInContext class to trigger validation
            setAllowedInContextStatus(isAllowedInContext);
            setCobrandStatus(showCobrand);
            setCCImageStatus(showCCImage);
            // trigger validation
            $("#paymentoptionForm").validate();
        }
        function setAllowedInContextStatus(status) {
            if (status) {
                $("#cardNumber").removeClass("notAllowedInContext");
            } else {
                $("#cardNumber").addClass("notAllowedInContext");
            }
        }
        function setCobrandStatus(status) {
            if (status) {
                $("#cobrand").show();
            } else {
                $("#cobrand").hide();
                $("#cobrand .toggle-cobrand").show();
                $("#cobrand .cobrand-wrapper").hide();
            }
        }
        function setCCImageStatus(status) {
            if (status) {
                $("#cardNumber").parent().find(".cc-image").show();
            } else {
                $("#cardNumber").parent().find(".cc-image").hide();
            }
        }

        function encrypt() {

            $("#loading").show();

            // Create an SDK encryptor object
            var encryptor = session.getEncryptor(forge);

            // Encrypting is an async task that we provide you as a promise.
            encryptor.encrypt(paymentRequest).then(function (encryptedString) {
                // The promise has fulfilled.
                sessionStorage.setItem('encryptedString', encryptedString);
                document.location.href = 'dev-success.html';
            }, function (errors) {
                // The promise failed, inform the user what happened.

                $("#loading").hide();
                console.error("Failed to encrypt due to", errors);
            });
        }
    };

    var context = sessionStorage.getItem('context');
    if (!context) {
        document.location.href = 'dev-start.html';
    }
    context = JSON.parse(context);
    var sessionDetails = {
        clientSessionID: context.clientSessionId,
        customerId: context.customerId,
        region: context.region,
        environment: context.environment
    };
    var paymentDetails = {
        totalAmount: context.amountInCents,
        countryCode: context.countryCode,
        locale: context.locale,
        isRecurring: context.isRecurring,
        currency: context.currencyCode
    }
    var grouping = context.grouping;
    var session = new connectSDK(sessionDetails);
    var paymentRequest = session.getPaymentRequest();

    var search = document.location.search;
    if (search) {
        search = search.substring(1);
        search = search.split("&");
        $.each(search, function (i, part) {
            part = part.split("=");
            if (part[0] === "paymentitemId") {
                _showPaymentItem(part[1]);
            }
        })
    } else {
        $("#error").fadeIn();
    }
});