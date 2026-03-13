# Bitrix24 CRM API Documentation

## Available Tools

### Deal Management

#### bitrix24_list_deals
List deals with optional filtering and ordering.

**Parameters:**
- `limit` (number, optional): Maximum number of deals to return (default: 20)
- `filter` (object, optional): Filter criteria (e.g., `{"TITLE": "Project"}`)
- `orderBy` (string, optional): Field to order by - `DATE_CREATE`, `DATE_MODIFY`, `ID`, `TITLE` (default: `DATE_CREATE`)
- `orderDirection` (string, optional): Order direction - `ASC` or `DESC` (default: `DESC`)

**Example:**
```javascript
// Get latest deals from 2025
{
  "limit": 20,
  "filter": {
    ">=DATE_CREATE": "2025-01-01",
    "<=DATE_CREATE": "2025-12-31"
  },
  "orderBy": "DATE_CREATE",
  "orderDirection": "DESC"
}
```

#### bitrix24_get_latest_deals
Get the most recent deals ordered by creation date.

**Parameters:**
- `limit` (number, optional): Maximum number of deals to return (default: 20)

#### bitrix24_get_deals_from_date_range
Get deals created within a specific date range.

**Parameters:**
- `startDate` (string, required): Start date in YYYY-MM-DD format
- `endDate` (string, optional): End date in YYYY-MM-DD format
- `limit` (number, optional): Maximum number of deals to return (default: 50)

**Example:**
```javascript
// Get deals from 2025
{
  "startDate": "2025-01-01",
  "endDate": "2025-12-31",
  "limit": 50
}
```

### Common Date Filter Patterns

#### Correct Date Filtering
```javascript
// For deals in 2025
{
  "filter": {
    ">=DATE_CREATE": "2025-01-01",
    "<=DATE_CREATE": "2025-12-31"
  }
}

// For deals from a specific date onwards
{
  "filter": {
    ">=DATE_CREATE": "2025-01-01"
  }
}

// For deals before a specific date
{
  "filter": {
    "<=DATE_CREATE": "2025-12-31"
  }
}
```

#### Incorrect Date Filtering (Will cause HTTP 400 errors)
```javascript
// ❌ Wrong - This format is not supported
{
  "filter": {
    "DATE_CREATE": "2025"
  }
}

// ❌ Wrong - Incorrect operator format
{
  "filter": {
    "<=DATE_CREATE": "2025-12-31",
    ">=DATE_CREATE": "2025-01-01"
  }
}
```

## Deal Fields Reference

Common deal fields returned by the API:
- `ID`: Deal ID
- `TITLE`: Deal title
- `STAGE_ID`: Current stage (e.g., "NEW", "WON", "LOSE")
- `OPPORTUNITY`: Deal amount
- `CURRENCY_ID`: Currency code (e.g., "EUR", "USD")
- `CONTACT_ID`: Associated contact ID
- `COMPANY_ID`: Associated company ID
- `DATE_CREATE`: Creation date
- `DATE_MODIFY`: Last modification date
- `BEGINDATE`: Deal start date
- `CLOSEDATE`: Deal close date
- `ASSIGNED_BY_ID`: Responsible user ID
- `COMMENTS`: Deal comments

## Error Handling

### Common Errors and Solutions

1. **HTTP 400: Bad Request**
   - Usually caused by incorrect filter syntax
   - Check date format (must be YYYY-MM-DD)
   - Verify filter operators (`>=`, `<=`, `=`)

2. **No results for recent dates**
   - Your CRM may not have deals from that period
   - Check if deals exist using broader date ranges
   - Verify the DATE_CREATE field contains expected dates

### Troubleshooting Steps

1. First, try getting all deals without filters:
   ```javascript
   { "limit": 50 }
   ```

2. Then add date filtering gradually:
   ```javascript
   {
     "filter": { ">=DATE_CREATE": "2024-01-01" },
     "limit": 50
   }
   ```

3. Check the actual date ranges in your data before filtering for specific years.

---

## Original Bitrix24 Documentation Examples

How to Search in CRM by Phone and E-mail
Scope: crm

Who can execute the method: users with administrative access to the CRM section

The example displays a form for entering a phone number and e-mail. Below the form, a table is shown with the search results by columns:

id of the entity
object type
title
entity's phone numbers
entity's e-mails
The code uses duplicate search to find all objects: lead, contact, company that have the specified phone number or e-mail. Then, from the list of all IDs, information about each entity is retrieved and displayed in the table:

title or first and last name
all phone numbers
e-mail
let phone = BX24.getPost('PHONE') ? BX24.getPost('PHONE') : false;
let email = BX24.getPost('EMAIL') ? BX24.getPost('EMAIL') : false;

let entityIDs = {
    'LEAD': [],
    'CONTACT': [],
    'COMPANY': []
};
let resultEntity = {
    'lead': [],
    'contact': [],
    'company': []
};

if (phone) {
    BX24.callMethod('crm.duplicate.findbycomm', {
        'type': 'PHONE',
        'values': [phone]
    }, function(result) {
        if (result.error()) {
            console.error(result.error());
        } else {
            if (Array.isArray(result.data().LEAD)) {
                entityIDs.LEAD = entityIDs.LEAD.concat(result.data().LEAD);
            }
            if (Array.isArray(result.data().CONTACT)) {
                entityIDs.CONTACT = entityIDs.CONTACT.concat(result.data().CONTACT);
            }
            if (Array.isArray(result.data().COMPANY)) {
                entityIDs.COMPANY = entityIDs.COMPANY.concat(result.data().COMPANY);
            }
        }
    });
}

if (email) {
    BX24.callMethod('crm.duplicate.findbycomm', {
        'type': 'EMAIL',
        'values': [email]
    }, function(result) {
        if (result.error()) {
            console.error(result.error());
        } else {
            if (Array.isArray(result.data().LEAD)) {
                entityIDs.LEAD = entityIDs.LEAD.concat(result.data().LEAD);
            }
            if (Array.isArray(result.data().CONTACT)) {
                entityIDs.CONTACT = entityIDs.CONTACT.concat(result.data().CONTACT);
            }
            if (Array.isArray(result.data().COMPANY)) {
                entityIDs.COMPANY = entityIDs.COMPANY.concat(result.data().COMPANY);
            }
        }
    });
}

if (entityIDs.LEAD.length > 0) {
    BX24.callMethod('crm.lead.list', {
        'filter': {
            'ID': entityIDs.LEAD
        },
        'select': ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL', 'TITLE']
    }, function(result) {
        if (result.error()) {
            console.error(result.error());
        } else {
            if (result.data().length > 0) {
                resultEntity.lead = result.data();
            }
        }
    });
}

if (entityIDs.CONTACT.length > 0) {
    BX24.callMethod('crm.contact.list', {
        'filter': {
            'ID': entityIDs.CONTACT
        },
        'select': ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL']
    }, function(result) {
        if (result.error()) {
            console.error(result.error());
        } else {
            if (result.data().length > 0) {
                resultEntity.contact = result.data();
            }
        }
    });
}

if (entityIDs.COMPANY.length > 0) {
    BX24.callMethod('crm.company.list', {
        'filter': {
            'ID': entityIDs.COMPANY
        },
        'select': ['ID', 'PHONE', 'EMAIL', 'TITLE']
    }, function(result) {
        if (result.error()) {
            console.error(result.error());
        } else {
            if (result.data().length > 0) {
                resultEntity.company = result.data();
            }
        }
    });
}
<!DOCTYPE html>
<html lang="en">
    <head>
        <link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.3.1/css/bootstrap.min.css" crossorigin="anonymous">
    </head>
    <body class="container">
        <form method="post" action="">
            <div class="row">
                <div class="col-4 mt-3">
                    <label>E-mail*</label>
                </div>
                <div class="col-6 mt-3">
                    <input type="text" name="EMAIL" value="">
                </div>
            </div>
            <div class="row">
                <div class="col-4 mt-3">
                    <label>Phone*</label>
                </div>
                <div class="col-6 mt-3">
                    <input type="text" name="PHONE" value="">
                </div>
            </div>
            <div class="row">
                <div class="col-sm-10">
                    <input type="submit" name="SEARCH" class="btn btn-primary" value="Search">
                </div>
            </div>
        </form>
        <table class="table mt-5">
            <thead>
                <tr>
                    <th scope="col">ID</th>
                    <th scope="col">Entity</th>
                    <th scope="col">Title</th>
                    <th scope="col">Phones</th>
                    <th scope="col">Emails</th>
                </tr>
            </thead>
            <tbody id="resultTable">
            </tbody>
        </table>
        <script src="https://api.bitrix24.com/api/v1/"></script>
        <script>
            document.querySelector('form').addEventListener('submit', function(event) {
                event.preventDefault();
                let phone = document.querySelector('input[name="PHONE"]').value;
                let email = document.querySelector('input[name="EMAIL"]').value;

                let entityIDs = {
                    'LEAD': [],
                    'CONTACT': [],
                    'COMPANY': []
                };
                let resultEntity = {
                    'lead': [],
                    'contact': [],
                    'company': []
                };

                if (phone) {
                    BX24.callMethod('crm.duplicate.findbycomm', {
                        'type': 'PHONE',
                        'values': [phone]
                    }, function(result) {
                        if (result.error()) {
                            console.error(result.error());
                        } else {
                            if (Array.isArray(result.data().LEAD)) {
                                entityIDs.LEAD = entityIDs.LEAD.concat(result.data().LEAD);
                            }
                            if (Array.isArray(result.data().CONTACT)) {
                                entityIDs.CONTACT = entityIDs.CONTACT.concat(result.data().CONTACT);
                            }
                            if (Array.isArray(result.data().COMPANY)) {
                                entityIDs.COMPANY = entityIDs.COMPANY.concat(result.data().COMPANY);
                            }
                        }
                    });
                }

                if (email) {
                    BX24.callMethod('crm.duplicate.findbycomm', {
                        'type': 'EMAIL',
                        'values': [email]
                    }, function(result) {
                        if (result.error()) {
                            console.error(result.error());
                        } else {
                            if (Array.isArray(result.data().LEAD)) {
                                entityIDs.LEAD = entityIDs.LEAD.concat(result.data().LEAD);
                            }
                            if (Array.isArray(result.data().CONTACT)) {
                                entityIDs.CONTACT = entityIDs.CONTACT.concat(result.data().CONTACT);
                            }
                            if (Array.isArray(result.data().COMPANY)) {
                                entityIDs.COMPANY = entityIDs.COMPANY.concat(result.data().COMPANY);
                            }
                        }
                    });
                }

                setTimeout(function() {
                    if (entityIDs.LEAD.length > 0) {
                        BX24.callMethod('crm.lead.list', {
                            'filter': {
                                'ID': entityIDs.LEAD
                            },
                            'select': ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL', 'TITLE']
                        }, function(result) {
                            if (result.error()) {
                                console.error(result.error());
                            } else {
                                if (result.data().length > 0) {
                                    resultEntity.lead = result.data();
                                }
                            }
                        });
                    }

                    if (entityIDs.CONTACT.length > 0) {
                        BX24.callMethod('crm.contact.list', {
                            'filter': {
                                'ID': entityIDs.CONTACT
                            },
                            'select': ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL']
                        }, function(result) {
                            if (result.error()) {
                                console.error(result.error());
                            } else {
                                if (result.data().length > 0) {
                                    resultEntity.contact = result.data();
                                }
                            }
                        });
                    }

                    if (entityIDs.COMPANY.length > 0) {
                        BX24.callMethod('crm.company.list', {
                            'filter': {
                                'ID': entityIDs.COMPANY
                            },
                            'select': ['ID', 'PHONE', 'EMAIL', 'TITLE']
                        }, function(result) {
                            if (result.error()) {
                                console.error(result.error());
                            } else {
                                if (result.data().length > 0) {
                                    resultEntity.company = result.data();
                                }
                            }
                        });
                    }

                    setTimeout(function() {
                        let resultTable = document.getElementById('resultTable');
                        resultTable.innerHTML = '';

                        for (let entity in resultEntity) {
                            resultEntity[entity].forEach(function(item) {
                                let phones = '';
                                if (item.PHONE) {
                                    phones = item.PHONE.map(phone => phone.VALUE).join(', ');
                                }
                                let emails = '';
                                if (item.EMAIL) {
                                    emails = item.EMAIL.map(email => email.VALUE).join(', ');
                                }
                                let title = item.TITLE ? item.TITLE + (item.NAME || item.LAST_NAME ? ': ' : '') : '';
                                if (item.NAME || item.LAST_NAME) {
                                    title += [item.NAME, item.LAST_NAME].join(' ');
                                }

                                let row = `<tr>
                                    <th scope="row">${item.ID}</th>
                                    <td>${entity}</td>
                                    <td>${title}</td>
                                    <td>${phones}</td>
                                    <td>${emails}</td>
                                </tr>`;
                                resultTable.innerHTML += row;
                            });
                        }
                    }, 1000);
                }, 1000);
            });
        </script>
    </body>
</html>



Previous
How to Get Lists
Next
How to Get a List of Activities
Logo icon
Getting Started
Whats New
Typical Use-Cases
API Methods
GitHub

Search
Bitrix24 REST API and Market Applications
How to Get a List of Activities
Scope: crm

Who can execute the method: users with administrative access to the CRM section

The example retrieves a list of incomplete activities for a contact. To get activities for other objects, replace the value in the OWNER_TYPE_ID field. A list of possible values for this field can be obtained using the method crm.enum.ownertype.

Note

To use the examples in PHP, configure the CRest class and include the crest.php file in the files where this class is used. Learn more

var contactID = 1;
var resultActivity = [];

BX24.callMethod(
    "crm.activity.list",
    {
        filter: {
            COMPLETED: "N", //only new activity
            OWNER_ID: contactID,
            OWNER_TYPE_ID: 3 // CRest::call('crm.enum.ownertype');
        },
        select: [
            "*",
            "COMMUNICATIONS"
        ]
    },
    function(result) {
        if(result.error())
            console.error(result.error());
        else
            console.dir(result.data());
    }
);



Previous
How to Search in CRM by Phone and e-mail
Next
How to Get a List of Lead Statuses with Semantics
Logo icon
Getting Started
Whats New
Typical Use-Cases
API Methods
GitHub

Search
Bitrix24 REST API and Market Applications
How to Get a List of Lead Statuses with Semantics
Scope: crm

Who can execute the method: users with administrative access to the CRM section

Example of retrieving all lead statuses with semantics.

BX24.callMethod('crm.status.list', { filter: { ENTITY_ID: 'STATUS' } }, function(resultLeads) {
    if (resultLeads.error()) {
        console.error(resultLeads.error());
    } else {
        if (resultLeads.data().length > 0) {
            var table = document.createElement('table');

            var thead = document.createElement('thead');
            var trHead = document.createElement('tr');
            ['STATUS ID', 'NAME', 'SEMANTICS'].forEach(function(text) {
                var th = document.createElement('th');
                th.textContent = text;
                trHead.appendChild(th);
            });
            thead.appendChild(trHead);
            table.appendChild(thead);

            var tbody = document.createElement('tbody');
            resultLeads.data().forEach(function(item) {
                var tr = document.createElement('tr');
                if (item.EXTRA && item.EXTRA.COLOR) {
                    tr.style.color = item.EXTRA.COLOR;
                }
                ['STATUS_ID', 'NAME', 'EXTRA.SEMANTICS'].forEach(function(key) {
                    var td = document.createElement('td');
                    td.textContent = key.split('.').reduce(function(acc, k) {
                        return acc && acc[k];
                    }, item);
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);

            document.body.appendChild(table);
        }
    }
});



Previous
How to Get a List of Activities
Next
How to Get a List of Estimate Statuses
Logo icon
Getting Started
Whats New
Typical Use-Cases
API Methods
GitHub

Search
Bitrix24 REST API and Market Applications
How to Get a List of Estimate Statuses
Scope: crm

Who can execute the method: users with administrative access to the CRM section

Example of retrieving all statuses of estimates with semantics.

BX24.callMethod('crm.status.list', { filter: { ENTITY_ID: 'QUOTE_STATUS' } }, function(resultQuote) {
    if (resultQuote.error()) {
        console.error(resultQuote.error());
    } else {
        if (resultQuote.data().length > 0) {
            var table = document.createElement('table');

            var thead = document.createElement('thead');
            var trHead = document.createElement('tr');
            ['STATUS ID', 'NAME', 'SEMANTICS'].forEach(function(text) {
                var th = document.createElement('th');
                th.textContent = text;
                trHead.appendChild(th);
            });
            thead.appendChild(trHead);
            table.appendChild(thead);

            var tbody = document.createElement('tbody');
            resultQuote.data().forEach(function(item) {
                var tr = document.createElement('tr');
                if (item.EXTRA && item.EXTRA.COLOR) {
                    tr.style.color = item.EXTRA.COLOR;
                }
                ['STATUS_ID', 'NAME', 'EXTRA.SEMANTICS'].forEach(function(key) {
                    var td = document.createElement('td');
                    td.textContent = key.split('.').reduce(function(acc, k) {
                        return acc && acc[k];
                    }, item);
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);

            document.body.appendChild(table);
        }
    }
});



Previous
How to Get a List of Lead Statuses with Semantics
Next
How to Get a Deal Funnel for a Given Direction
Logo icon
Getting Started
Whats New
Typical Use-Cases
API Methods
GitHub

Search
Bitrix24 REST API and Market Applications
How to Get the Sales Funnel of a Given Direction with the Semantics of Each Deal Stage
Scope: crm

Who can execute the method: users with administrative access to the CRM section

This example outputs all existing deal directions along with the semantics for each stage.

var arCategory = [];

BX24.callMethod('crm.dealcategory.list', {}, function(result) {
    if (result.error()) {
        console.error(result.error());
    } else {
        arCategory = result.data().reduce(function(acc, item) {
            acc[item.ID] = item.NAME;
            return acc;
        }, {});

        BX24.callMethod('crm.dealcategory.default.get', {}, function(result) {
            if (result.error()) {
                console.error(result.error());
            } else {
                arCategory[result.data().ID] = result.data().NAME;

                Object.keys(arCategory).forEach(function(id) {
                    var entity_id = id > 0 ? 'DEAL_STAGE_' + id : 'DEAL_STAGE';

                    BX24.callMethod('crm.status.list', { filter: { ENTITY_ID: entity_id } }, function(resultDeal) {
                        if (resultDeal.error()) {
                            console.error(resultDeal.error());
                        } else {
                            var table = document.createElement('table');
                            var caption = document.createElement('caption');
                            caption.textContent = arCategory[id];
                            table.appendChild(caption);

                            var thead = document.createElement('thead');
                            var trHead = document.createElement('tr');
                            ['STATUS ID', 'NAME', 'SEMANTICS'].forEach(function(text) {
                                var th = document.createElement('th');
                                th.textContent = text;
                                trHead.appendChild(th);
                            });
                            thead.appendChild(trHead);
                            table.appendChild(thead);

                            var tbody = document.createElement('tbody');
                            resultDeal.data().forEach(function(item) {
                                var tr = document.createElement('tr');
                                if (item.EXTRA && item.EXTRA.COLOR) {
                                    tr.style.color = item.EXTRA.COLOR;
                                }
                                ['STATUS_ID', 'NAME', 'EXTRA.SEMANTICS'].forEach(function(key) {
                                    var td = document.createElement('td');
                                    td.textContent = key.split('.').reduce(function(acc, k) {
                                        return acc && acc[k];
                                    }, item);
                                    tr.appendChild(td);
                                });
                                tbody.appendChild(tr);
                            });
                            table.appendChild(tbody);

                            document.body.appendChild(table);
                        }
                    });
                });
            }
        });
    }
});



Previous
How to Get a List of Estimate Statuses
Next
How to Get a Client's Address from CRM
Logo icon
Getting Started
Whats New
Typical Use-Cases
API Methods
GitHub

Search
Bitrix24 REST API and Market Applications
In this article:
1. Retrieving Requisites Associated with a Contact
2. Retrieving the Address
Code Example
How to Get a Client's Address from CRM
Scope: crm

Who can execute the method: users with administrative access to the CRM section

A client's address can be stored in Bitrix:

in a user-defined field of type "address" for any CRM entity. To retrieve the address from the field, call the get or list method for the desired entity type.
in the requisites of contacts, companies, and leads. Within a single field Address, multiple addresses can be stored with their types specified. A single client may have several requisites recorded.
To obtain a client's address from the requisites, sequentially execute two methods:

crm.requisite.list
crm.address.list
1. Retrieving Requisites Associated with a Contact
Obtaining the requisite ID is a necessary step, as the address does not have a direct link to the contact or company. The address is linked to the requisite object.

To retrieve the requisites, we use the crm.requisite.list method with the following filter:

in ENTITY_TYPE_ID, specify the value 3 — the identifier for contact type. For company type, use the identifier 4.
in ENTITY_ID — the contact ID, in this example 2429. You can obtain the ID using the crm.contact.list method with a filter based on any known contact field. To get the company ID, use crm.company.list. If you need to obtain the contact or company ID by phone number or email, refer to the tutorial “Finding Duplicates by Phone Number”.
How to Use Examples in Documentation

BX24.callMethod(
"crm.requisite.list",
    {
    filter: { 
         "ENTITY_TYPE_ID": "3", 
         "ENTITY_ID": "2429",      
        },
    select: [
        "ID",
        "ENTITY_TYPE_ID",
        "ENTITY_ID",
        ],
    },
);

We obtained the requisite ID 361 — a parameter necessary for the next request.

   Array
   (
    [result] => Array
       (
           [0] => Array
               (
                   [ID] => 361
                   [ENTITY_TYPE_ID] => 3
                   [ENTITY_ID] => 2429
               )
       )
    [total] => 1      
   )

2. Retrieving the Address
To obtain the address, we use the crm.address.list method with the following filter:

in ENTITY_TYPE_ID, specify the value 8 — the identifier for requisite type
in ENTITY_ID — the requisite ID obtained from the previous request, in this example 361
in TYPE_ID — the address type, if you need to retrieve a specific one. For example, the delivery address type is 11, and the legal address type is 6.
BX24.callMethod(
    "crm.address.list",
    {
        filter: { 
        "ENTITY_TYPE_ID": 8, 
        "ENTITY_ID": 361,  
        "TYPE_ID": 11, 
        },
    },
);

We received the delivery address data for the contact.

    Array
    (
        [result] => Array
            (
                [0] => Array
                    (
                        [TYPE_ID] => 11
                        [ENTITY_TYPE_ID] => 8
                        [ENTITY_ID] => 361
                        [ADDRESS_1] => 45th Lane, 10 c1
                        [ADDRESS_2] => 
                        [CITY] => New York
                        [POSTAL_CODE] => 10001
                        [REGION] => Manhattan
                        [PROVINCE] => New York
                        [COUNTRY] => USA
                        [COUNTRY_CODE] => 
                        [LOC_ADDR_ID] => 571
                        [ANCHOR_TYPE_ID] => 3
                        [ANCHOR_ID] => 2429
                    )
            )
        [total] => 1       
    )

Code Example
var contactId = "your_contact_ID_here"; // Replace with the actual contact ID

// Method to retrieve the requisite ID
BX24.callMethod(
    "crm.requisite.list",
    {
        filter: {
            "ENTITY_TYPE_ID": 3,
            "ENTITY_ID": contactId
        },
        select: ["ID"]
    },
    function(requisiteResult) {
        if (requisiteResult.error()) {
            console.error(requisiteResult.error());
        } else {
            var requisites = requisiteResult.data();
            if (requisites.length > 0) {
                var requisiteId = requisites[0].ID;
                console.log("Requisite ID:", requisiteId);

                // Method to retrieve the address
                BX24.callMethod(
                    "crm.address.list",
                    {
                        filter: {
                            "ENTITY_TYPE_ID": 8,
                            "ENTITY_ID": requisiteId,
                            "TYPE_ID": 11
                        }
                    },
                    function(addressResult) {
                        if (addressResult.error()) {
                            console.error(addressResult.error());
                        } else {
                            var addresses = addressResult.data();
                            if (addresses.length > 0) {
                                // Create a table to display the addresses
                                var table = [];
                                addresses.forEach(function(address) {
                                    table.push({
                                        "Address": address.ADDRESS_1 || "Not specified",
                                        "City": address.CITY || "Not specified",
                                        "Postal Code": address.POSTAL_CODE || "Not specified",
                                        "Country": address.COUNTRY || "Not specified"
                                    });
                                });
                                console.table(table);
                            } else {
                                console.log("Delivery address not found.");
                            }
                        }
                    }
                );
            } else {
                console.log("Requisite not found.");
            }
        }
    }
);

Previous
How to Get a Deal Funnel for a Given Direction
Next
How to Filter Elements by Stage Name
Logo icon
Getting Started
Whats New
Typical Use-Cases
API Methods
GitHub

Search
Bitrix24 REST API and Market Applications
In this article:
1. Retrieve the Funnel Identifier
2. Retrieve the Stage Identifier
3. Retrieve the List of Items at the Stage
Retrieve the Responsible Person's Data
Code Example
How to Filter Items by Stage Name
Scope: crm, user_brief

Who can execute the method: a user with read access to CRM entities

The stage name is not stored in the "Stage" field of the CRM entity. The "Stage" field contains an identifier. You can match the name and identifier of the stage using methods for working with dictionaries — system fields of the "list" type. To search for items by stage name, we will sequentially execute three methods:

crm.category.list — retrieve the funnel identifier
crm.status.list — retrieve the stage identifier in the funnel
crm.item.list — retrieve the list of items at the stage
1. Retrieve the Funnel Identifier
We will use the method crm.category.list with the parameters:

entityTypeId — specify 2 for deals. This is the identifier of the object type. To find out the identifier of the SPA, execute the method crm.enum.ownertype without parameters.
How to Use Examples in Documentation

BX24.callMethod(
    "crm.category.list",
    {
        entityTypeId: 2,
    },
);

As a result, we received the deal funnels. We will identify the required funnel by its name in the name field. The funnel identifier will be taken from the id field.

{
    "result": {
        "categories": [
            {
                "id": 9,
                "name": "Funnel with Original Name",
                "sort": 200,
                "entityTypeId": 2,
                "isDefault": "N",
                "originId": "",
                "originatorId": ""
            },
            {
                "id": 10,
                "name": "Lead Route",
                "sort": 200,
                "entityTypeId": 2,
                "isDefault": "N",
                "originId": "",
                "originatorId": ""
            },
            {
                "id": 11,
                "name": "Path to Success",
                "sort": 200,
                "entityTypeId": 2,
                "isDefault": "N",
                "originId": "",
                "originatorId": ""
            },
            {
                "id": 0,
                "name": "General",
                "sort": 300,
                "entityTypeId": 2,
                "isDefault": "Y"
            }
        ]
    },
    "total": 4,
}

2. Retrieve the Stage Identifier
We will use the method crm.status.list with the filter:

ENTITY_ID — specify DEAL_STAGE_10, where 10 is the funnel identifier obtained in step 1.
To obtain the stages of the SPA, use a formula like DYNAMIC_185_STAGE_11, where 185 is the ID of the SPA, and 11 is the ID of the funnel.
If the ID of the funnel is 0, make the request for stages without adding _ID.
BX24.callMethod(
    "crm.status.list",
    {
        filter: { "ENTITY_ID": "DEAL_STAGE_10"}
    },
);

As a result, we received a list of stages. We will identify the required stage by its name in the NAME field. The stage identifier will be taken from the STATUS_ID field.

{
    "result": [
        {
            "ID": "331",
            "ENTITY_ID": "DEAL_STAGE_10",
            "STATUS_ID": "C10:NEW",
            "NAME": "New",
            "NAME_INIT": "New",
            "SORT": "10",
            "SYSTEM": "Y",
            "CATEGORY_ID": "5",
            "COLOR": "#39A8EF",
            "SEMANTICS": null,
            "EXTRA": {
                "SEMANTICS": "process",
                "COLOR": "#39A8EF"
            }
        },
        {
            "ID": "333",
            "ENTITY_ID": "DEAL_STAGE_10",
            "STATUS_ID": "C10:PREPARATION",
            "NAME": "Document Preparation",
            "NAME_INIT": "",
            "SORT": "20",
            "SYSTEM": "N",
            "CATEGORY_ID": "5",
            "COLOR": "#2FC6F6",
            "SEMANTICS": null,
            "EXTRA": {
                "SEMANTICS": "process",
                "COLOR": "#2FC6F6"
            }
        },
        {
            "ID": "335",
            "ENTITY_ID": "DEAL_STAGE_10",
            "STATUS_ID": "C10:PREPAYMENT_INVOICE",
            "NAME": "Approval",
            "NAME_INIT": "",
            "SORT": "30",
            "SYSTEM": "N",
            "CATEGORY_ID": "5",
            "COLOR": "#55d0e0",
            "SEMANTICS": null,
            "EXTRA": {
                "SEMANTICS": "process",
                "COLOR": "#55d0e0"
            }
        },
        {
            "ID": "337",
            "ENTITY_ID": "DEAL_STAGE_10",
            "STATUS_ID": "C10:EXECUTING",
            "NAME": "In Progress",
            "NAME_INIT": "",
            "SORT": "40",
            "SYSTEM": "N",
            "CATEGORY_ID": "5",
            "COLOR": "#47E4C2",
            "SEMANTICS": null,
            "EXTRA": {
                "SEMANTICS": "process",
                "COLOR": "#47E4C2"
            }
        },
        {
            "ID": "339",
            "ENTITY_ID": "DEAL_STAGE_10",
            "STATUS_ID": "C10:FINAL_INVOICE",
            "NAME": "Final Invoice",
            "NAME_INIT": "",
            "SORT": "50",
            "SYSTEM": "N",
            "CATEGORY_ID": "5",
            "COLOR": "#FFA900",
            "SEMANTICS": null,
            "EXTRA": {
                "SEMANTICS": "process",
                "COLOR": "#FFA900"
            }
        },
        {
            "ID": "341",
            "ENTITY_ID": "DEAL_STAGE_10",
            "STATUS_ID": "C10:WON",
            "NAME": "Deal Won",
            "NAME_INIT": "Deal Won",
            "SORT": "60",
            "SYSTEM": "Y",
            "CATEGORY_ID": "5",
            "COLOR": "#7BD500",
            "SEMANTICS": "S",
            "EXTRA": {
                "SEMANTICS": "success",
                "COLOR": "#7BD500"
            }
        },
        {
            "ID": "343",
            "ENTITY_ID": "DEAL_STAGE_10",
            "STATUS_ID": "C10:LOSE",
            "NAME": "Deal Lost",
            "NAME_INIT": "Deal Lost",
            "SORT": "70",
            "SYSTEM": "Y",
            "CATEGORY_ID": "5",
            "COLOR": "#FF5752",
            "SEMANTICS": "F",
            "EXTRA": {
                "SEMANTICS": "failure",
                "COLOR": "#FF5752"
            }
        },
        {
            "ID": "345",
            "ENTITY_ID": "DEAL_STAGE_10",
            "STATUS_ID": "C10:APOLOGY",
            "NAME": "Analysis of Failure Reason",
            "NAME_INIT": "",
            "SORT": "80",
            "SYSTEM": "N",
            "CATEGORY_ID": "5",
            "COLOR": "#FF5752",
            "SEMANTICS": "F",
            "EXTRA": {
                "SEMANTICS": "apology",
                "COLOR": "#FF5752"
            }
        }
    ],
    "total": 8,
}

3. Retrieve the List of Items at the Stage
We will use the method crm.item.list with the parameters:

entityTypeId — specify 2 for deals. This is the identifier of the object type. To find out the identifier of the SPA, execute the method crm.enum.ownertype without parameters.
filter[stageId] — specify C10:PREPAYMENT_INVOICE. This is the stage identifier obtained in step 2.
select[] — specify the fields of the items that we want to retrieve. Without the select parameter, all fields, including custom ones, will be returned.
BX24.callMethod(
    'crm.item.list',
    {
        entityTypeId: 2,
        select: [
            "id", 
            "title",
            "assignedById", 
            "opportunity", 
        ],
        filter: {
            "stageId": ["C10:PREPAYMENT_INVOICE"],
        },
    },
);

As a result, we received a list of items at the requested stage.

{
    "result": {
        "items": [
            {
                "id": 5111,
                "assignedById": 1,
                "title": "Purchase of Stoves",
                "opportunity": 500
            },
            {
                "id": 5199,
                "assignedById": 29,
                "title": "Purchase of Heaters",
                "opportunity": 250
            },
            {
                "id": 5257,
                "assignedById": 29,
                "title": "Purchase of Bread Makers",
                "opportunity": 200
            },
            {
                "id": 5273,
                "assignedById": 29,
                "title": "Purchase of Machines",
                "opportunity": 0
            },
            {
                "id": 5317,
                "assignedById": 29,
                "title": "Purchase of Blenders",
                "opportunity": 100
            }
        ]
    },
    "total": 5,
}

Retrieve the Responsible Person's Data
In the received result, the ID of the employee responsible for the item is specified. To display the first name and last name of the employee, we will use the method user.get with the filter:

ID — specify the value from the assignedById parameter obtained in step 3.
BX24.callMethod(
    "user.get",
    {
        "ID": 29
    },
);

As a result, we will receive data about the employee, including the fields NAME and LAST_NAME.

{
    "result": [
        {
            "ID": "29",
            "ACTIVE": true,
            "NAME": "Vadim",
            "LAST_NAME": "Valeev",
            "SECOND_NAME": "",
            "EMAIL": "v.r.valeev@bitrix.com",
            "LAST_LOGIN": "2025-05-15T13:06:54+00:00",
            "DATE_REGISTER": "2024-07-15T00:00:00+00:00",
            "TIME_ZONE": "",
            "IS_ONLINE": "Y",
            "TIMESTAMP_X": {
            },
            "LAST_ACTIVITY_DATE": {
            },
            "PERSONAL_GENDER": "",
            "PERSONAL_WWW": "",
            "PERSONAL_BIRTHDAY": "2000-07-14T00:00:00+00:00",
            "PERSONAL_MOBILE": "",
            "PERSONAL_CITY": "",
            "WORK_PHONE": "",
            "WORK_POSITION": "",
            "UF_EMPLOYMENT_DATE": "",
            "UF_DEPARTMENT": [1],
            "USER_TYPE": "employee"
        },
    ],
}

Code Example
// Step 1: Request the funnel name from the user
let funnelName = prompt("Enter the name of the deal funnel:");

// Step 2: Retrieve the list of funnels
BX24.callMethod(
    "crm.category.list",
    {
        entityTypeId: 2,
    },
    function (result) {
        if (result.error()) {
            console.error(result.error().ex);
            return;
        }

        let categories = result.data().categories;
        let selectedFunnel = categories.find(cat => cat.name === funnelName);

        if (!selectedFunnel) {
            alert("Funnel not found.");
            return;
        }

        let funnelId = selectedFunnel.id;

        // Step 3: Request the stage name from the user
        let stageName = prompt("Enter the name of the stage:");

        // Step 4: Retrieve the list of stages for the selected funnel
        let entityID = funnelId === 0 ? "DEAL_STAGE" : `DEAL_STAGE_${funnelId}`;

        BX24.callMethod(
            "crm.status.list",
            {
                filter: { "ENTITY_ID": entityID }
            },
            function (result) {
                if (result.error()) {
                    console.error(result.error().ex);
                    return;
                }

                let stages = result.data();
                let selectedStage = stages.find(stage => stage.NAME === stageName);

                if (!selectedStage) {
                    alert("Stage not found.");
                    return;
                }

                let stageId = selectedStage.STATUS_ID;

                // Step 5: Retrieve the list of deals at the selected stage
                BX24.callMethod(
                    "crm.item.list",
                    {
                        entityTypeId: 2,
                        select: ["id", "title", "assignedById", "opportunity"],
                        filter: {
                            "stageId": stageId,
                        },
                    },
                    function (result) {
                        if (result.error()) {
                            console.error(result.error().ex);
                            return;
                        }

                        let deals = result.data().items;
                        let uniqueResponsibleIds = [...new Set(deals.map(deal => deal.assignedById))];

                        let userMap = {};

                        // Step 6: Retrieve user information
                        uniqueResponsibleIds.forEach(userId => {
                            BX24.callMethod(
                                "user.get",
                                {
                                    "ID": userId
                                },
                                function (userResult) {
                                    if (userResult.error()) {
                                        console.error(userResult.error().ex);
                                        return;
                                    }

                                    let user = userResult.data()[0];
                                    userMap[userId] = {
                                        name: user.NAME,
                                        lastName: user.LAST_NAME
                                    };
                                }
                            );
                        });

                        // Step 7: Output results to the console in a text table format
                        setTimeout(() => {
                            let table = [];

                            // Header
                            table.push([
                                "Deal ID",
                                "Title",
                                "Responsible First Name",
                                "Responsible Last Name",
                                "Expected Revenue"
                            ]);

                            // Data rows
                            deals.forEach(deal => {
                                let responsible = userMap[deal.assignedById] || { name: "Unknown", lastName: "Unknown" };
                                table.push([
                                    deal.id,
                                    deal.title,
                                    responsible.name,
                                    responsible.lastName,
                                    deal.opportunity || 0
                                ]);
                            });

                            // Output the table to the console
                            console.table(table);
                        }, 1000); // Delay for all requests to complete
                    }
                );
            }
        );
    }
);

Previous
How to Get a Client's Address from CRM
Next
Sales Intelligence

Add a contact with details via a web form
Scope: crm

Who can execute the method: users with permission to create contacts in CRM

You can place a form on the site to collect client data and details. When a client fills out the form, their data will be sent to CRM, and you will be able to process the request.

Setting up the form consists of two steps.

We will place the form on a PHP page. In the page code, we will retrieve the list of detail templates and address fields for the form. The form data will be sent to the handler.

We will create a file to process the data. The handler will accept and prepare the data, and then create a contact with the details.

1. Creating the web form
To generate the form fields, we will use data from Bitrix24. To get information about the detail settings, we will sequentially execute two methods:

crm.address.fields — we retrieve the list of address fields. The result is saved in arAddressFields.

$arAddressFields = CRest::call('crm.address.fields', []);

crm.requisite.preset.list — we request the list of detail templates. Using the select parameter, we choose the ID and NAME fields for each template. The result is saved in arRequisiteType.

$arRequisiteType = CRest::call(
    'crm.requisite.preset.list', [
        'select' => ["ID", "NAME"]
    ]
);

We will add a web form to the site page with the following fields:

REQ_TYPE — a dropdown list with the type of details from the arRequisiteType array, required,

NAME — contact's first name, required,

LAST_NAME — last name,

PHONE — phone number,

${addressFieldsInputs} — address fields, which are created dynamically from the arAddressFields array.

The form sends data using the POST method to the form.php file.

Full example of the page code with the form
How to Use Examples in Documentation

<?php
// Retrieve the list of address fields and detail templates
$arAddressFields = CRest::call('crm.address.fields', []);
$arRequisiteType = CRest::call('crm.requisite.preset.list', [
    'select' => ["ID", "NAME"]
]);

if (!empty($arRequisiteType['result'])): 
    $arRequisiteType = array_column($arRequisiteType['result'], 'NAME', 'ID');

    // Remove system and unused address fields
    $excludeFields = ['TYPE_ID', 'ENTITY_TYPE_ID', 'ENTITY_ID', 'COUNTRY_CODE', 'ANCHOR_TYPE_ID', 'ANCHOR_ID'];
    foreach ($excludeFields as $field) {
        unset($arAddressFields['result'][$field]);
    }
?>
    <form id="form_to_crm">
        <select name="REQ_TYPE" required>
            <option value="" disabled selected>Select the type of details</option>
            <?php foreach ($arRequisiteType as $id => $name): ?>
                <option value="<?=$id?>"><?=$name?></option>
            <?php endforeach; ?>
        </select>
        <input type="text" name="NAME" placeholder="First Name" required>
        <input type="text" name="LAST_NAME" placeholder="Last Name">
        <input type="text" name="PHONE" placeholder="Phone">
        <?php foreach ($arAddressFields['result'] as $key => $arField): ?>
            <input type="text" name="ADDRESS[<?=$key?>]" 
                   placeholder="<?=$arField['title']?>" 
                   <?=$arField['isRequired'] ? 'required' : ''?>>
        <?php endforeach; ?>
        <input type="submit" value="Submit">
    </form>
<?php else: ?>
    <p>No available types of details.</p>
<?php endif; ?>

<script src="https://ajax.googleapis.com/ajax/libs/jquery/3.3.1/jquery.min.js"></script> 
<script>
$(document).ready(function() {
    $('#form_to_crm').on('submit', function(el) {
        el.preventDefault();
        $.ajax({
            method: 'POST',
            dataType: 'json',
            url: 'form.php',
            data: $(this).serialize(),
            success: function(data) {
                alert(data.message);
            }
        });
    });
});
</script>

2. Creating the form handler
To process the values from the form fields and add a contact to CRM, we will create a handler form.php.

Preparing the data
We retrieve and clean the data from the form:

REQ_TYPE is converted to a number,

NAME, LAST_NAME, PHONE are cleaned of HTML tags.

$iRequisitePresetID = intVal($_POST["REQ_TYPE"]);
$sName = htmlspecialchars($_POST["NAME"]);
$sLastName = htmlspecialchars($_POST["LAST_NAME"]);
$sPhone = htmlspecialchars($_POST["PHONE"]);

We prepare the address fields and collect them into the $arAddress array.

The values of the fields from the form are cleaned of HTML tags.

We add the address type TYPE_ID. The address types can be obtained using the method crm.enum.addresstype. We will specify the value — 1, which means the actual address.

We add the identifier of the object type ENTITY_TYPE_ID. The identifiers can be obtained using the method crm.enum.ownertype. We will specify the value — 8, which means detail.

$arAddress = [];
foreach($_POST["ADDRESS"] as $key => $val) {
    $arAddress[$key] = htmlspecialchars($val);
}
$arAddress['TYPE_ID'] = 1;
$arAddress['ENTITY_TYPE_ID'] = 8;

The system stores the phone as an array of objects crm_multifield, so it needs to be formatted as an array.

We add the phone as the first element VALUE in the array, and the second value specifies the type VALUE_TYPE, for example, WORK.

For an empty value, we pass an empty array.

$arPhone = !empty($sPhone) ? [['VALUE' => $sPhone, 'VALUE_TYPE' => 'WORK']] : [];

Adding the contact
To create a contact, we will execute the method crm.contact.add. In the fields object, we pass the fields:

NAME — contact's first name,

LAST_NAME — last name,

PHONE — phone.

Check which required fields are set for contacts in your Bitrix24. All required fields must be passed to the method crm.contact.add.

CRest::call(
    'crm.contact.add', [
        'fields' => [
            'NAME' => $sName,
            'LAST_NAME' => $sLastName,
            'PHONE' => $arPhone
        ]
    ]
);

As a result, we will receive the identifier of the new contact, for example, 23.

{
	"result": 23
}

Adding details to the contact
To add details to the contact, we will execute the method crm.requisite.add. In the fields object, we pass the fields:

ENTITY_TYPE_ID — identifier of the object type. The identifiers can be obtained using the method crm.enum.ownertype. In the example, we will specify the value 3, which means contact,

ENTITY_ID — identifier of the contact received in the previous request,

PRESET_ID — identifier of the detail template received from the form,

ACTIVE — activity of the detail Y,

NAME — name of the detail, for example, we will combine the first name and last name of the contact.

CRest::call(
    'crm.requisite.add', 
    [
        'fields' => [
            'ENTITY_TYPE_ID' => 3,
            'ENTITY_ID' => $contactId,
            'PRESET_ID' => $iRequisitePresetID,
            'ACTIVE' => 'Y',
            'NAME' => implode(' ', [$sName, $sLastName]),
        ]
    ]
);

As a result, we will receive the identifier of the details.

{
    "result": 34
}

Adding an address for the detail
We will add an address for the detail using the method crm.address.add, if the detail was created successfully. In $arAddress, we add ENTITY_ID with the ID of the detail from the response of the previous request. In the fields object, we pass the array $arAddress with the address fields.

if(!empty($resultRequisite['result'])) {
	$arAddress['ENTITY_ID'] = $resultRequisite['result'];
	CRest::call(
		'crm.address.add',
		[
			'fields' => $arAddress
		]
	);
}

Full example of the handler code
<?php
require_once('crest.php');

// Retrieve and clean the form data
$iRequisitePresetID = intVal($_POST["REQ_TYPE"]);
$sName = htmlspecialchars($_POST["NAME"]);
$sLastName = htmlspecialchars($_POST["LAST_NAME"]);
$sPhone = htmlspecialchars($_POST["PHONE"]);

// Prepare the address
$arAddress = [];
foreach ($_POST["ADDRESS"] as $key => $val) {
    $arAddress[$key] = htmlspecialchars($val);
}
$arAddress['TYPE_ID'] = 1; // Actual address
$arAddress['ENTITY_TYPE_ID'] = 8; // Object type — detail

// Format the phone for Bitrix24
$arPhone = !empty($sPhone) ? [['VALUE' => $sPhone, 'VALUE_TYPE' => 'WORK']] : [];

// Create the contact
$result = CRest::call('crm.contact.add', [
    'fields' => [
        'NAME' => $sName,
        'LAST_NAME' => $sLastName,
        'PHONE' => $arPhone
    ]
]);

// Get the identifier of the new contact
if (!empty($result['result'])) {
    $contactId = $result['result'];

    // Add details for the new contact
    $resultRequisite = CRest::call('crm.requisite.add', [
        'fields' => [
            'ENTITY_TYPE_ID' => 3, // Object type — contact
            'ENTITY_ID' => $contactId,
            'PRESET_ID' => $iRequisitePresetID,
            'ACTIVE' => 'Y',
            'NAME' => implode(' ', [$sName, $sLastName]),
        ]
    ]);

    // Add address if details were created successfully
    if (!empty($resultRequisite['result'])) {
        $arAddress['ENTITY_ID'] = $resultRequisite['result'];
        CRest::call('crm.address.add', ['fields' => $arAddress]);
    }

    echo json_encode(['message' => 'Contact successfully added']);
} else {
    $error = !empty($result['error_description']) ? $result['error_description'] : 'Unknown error';
    echo json_encode(['message' => 'Error: ' . $error]);
}
?>

Previous
Add Contact
Next
