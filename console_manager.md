# the Terminal View subsystem
ok so the thing is i am thinking of a new age of a termial view with a very complex structre so that multiple seesion could be handeled in this modern terminal
## The Hierachy structure and the objects of the terminal panels
Ok so the thing is the terminal section will hae the following hierarchy

```
Console Master --> Console Panel --> Terminal Pane Tree --> Terminal Node --> Command Block
```

## Console manager
This will be  the main class handeling the console constainer this will be main application which will be Parent class to our main Terminal Panels with fetures liks
* Settings like themes , font option ,etc configuration 
* Navigation for the Different Panel session
---
### The Ui componenets of a Console manager
There are 2 main componnets of a Console manager
1. Side Navbar (on the left)
2. Top Navbar
3. Main Container for the Panels

### Ui Componente Description
#### Top Navbar
The top navebar will consist of the following componnets
* Side navbar toggle icon on the left 
* Close button on the right

#### Side Navbar
Side Navbar will have the following components where it will contain the  Setting Element as well as the Different Pane seesioon for differnt terminal layouts

#### Main Container
Main Container will store the panel Tree which will show our terminals


## Technical steructure of the Console

### The Consosle Manger
the console manage Obeject will be having the following properties

1. Panel Tree map
2. Terminal Session id map

**Scheme Level configs**
this will consist of filed like
* Background color
* font color
* font size

## Panel Tree 
The Panel tree will be a balanced Binary TRee which will be responsisble for the creation of the Terminal sessions
into the `Main Container` of the console panel 
### The Split logic of the panes in the panel
ok so the spitting logic
* So the splitting will be done accoding to th Panes in which they are spit in to 2 child Panes the terminal session in the parent pane will be shiferd to the child pane and the new session created to the next one 
* Each spilt could be horizontal or vertical 
* The split will be in 50-50 % split

